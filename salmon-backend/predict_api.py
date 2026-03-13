"""
Flask API server for fish origin classification
Serves the predict_web.html frontend and provides prediction API

SECURITY NOTES:
- Images are processed in memory only (no disk storage)
- Default: localhost-only access (127.0.0.1)
- CORS restricted to same-origin requests
- Request size limited to 50MB
- Generic error messages returned to clients
- Debug mode disabled by default

USAGE:
  Development:  FLASK_DEBUG=true python predict_api.py
  Production:   python predict_api.py
  Custom host:  FLASK_HOST=0.0.0.0 python predict_api.py
"""

import sys
import os
from pathlib import Path
import base64
import io
import uuid
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import wraps

# Add project root to path
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__)))
sys.path.insert(0, project_root)

from flask import Flask, request, jsonify, send_from_directory, Response, g
from flask_cors import CORS
import numpy as np
import torch
import torch.nn.functional as F
from torchvision import transforms
from PIL import Image
import cv2
import tifffile as tiff
import bcrypt
import jwt
from botocore.exceptions import ClientError

from src.config import IMG_SIZE, NORMALIZE_MEAN, NORMALIZE_STD, CHECKPOINT_PATH
from src.model.simple_multimodal_cnn import create_simple_multimodal_cnn
from src.utils import get_device
from src.image_preprocessing import preprocess_img_pipeline
from src.aws_config import (
    INFERENCE_S3_BUCKET,
    INFERENCE_S3_BASE_PREFIX,
    DYNAMODB_TABLE_NAME,
    AWS_REGION
)
from src.aws_utils import (
    generate_job_id,
    generate_image_id,
    upload_image_to_s3,
    create_job_meta,
    save_image_item,
    update_job_meta_num_images,
    get_job_num_images,
    get_all_history_data,
    get_all_jobs,
    get_job_images,
    delete_image_item,
    acknowledge_for_field
)
from src.aws_config import INFERENCE_S3_BUCKET, AWS_REGION
import boto3

app = Flask(__name__, static_folder='.')
# Security: Limit request size to 50MB
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

# CORS configuration - backward compatible with development and production
# Development: If FRONTEND_URL is not set, allows all origins (existing behavior)
# Production: Set FRONTEND_URL environment variable to restrict to specific domain
FRONTEND_URL = os.getenv('FRONTEND_URL', None)

# Build allowed origins list (localhost + S3 static website so deployed frontend can call API)
allowed_origins = [
    "http://localhost:5502",
    "http://127.0.0.1:5502",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://salmon-says-frontend.s3-website-us-west-2.amazonaws.com",
    "https://salmon-says-frontend.s3-website-us-west-2.amazonaws.com",
]

# If production URL is set, add it to the list
if FRONTEND_URL:
    allowed_origins.append(FRONTEND_URL.rstrip("/"))

# If no production URL is set, use wildcard for development (maintains existing behavior)
if not FRONTEND_URL:
    allowed_origins = ["*"]

CORS(app, resources={
    r"/api/*": {
        "origins": allowed_origins,  # Backward compatible: "*" in dev, restricted in prod
        "methods": ["POST", "GET", "PUT", "OPTIONS"],  # Added PUT for presigned upload
        "allow_headers": ["Content-Type", "Authorization"],
        "expose_headers": ["Content-Length", "Content-Type"]  # For presigned upload
    }
})

# Auth configuration (DynamoDB + JWT)
USERS_TABLE_NAME = os.getenv('USERS_TABLE_NAME', 'Users')
AUTH_AWS_REGION = os.getenv('AWS_REGION', AWS_REGION or 'us-west-2')
JWT_SECRET = os.getenv('JWT_SECRET', '')
JWT_ALGORITHM = 'HS256'
JWT_EXPIRE_SECONDS = int(os.getenv('JWT_EXPIRE_SECONDS', '28800'))  # 8 hours


def get_users_table():
    dynamodb = boto3.resource('dynamodb', region_name=AUTH_AWS_REGION)
    return dynamodb.Table(USERS_TABLE_NAME)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))
    except Exception:
        return False


def create_jwt(username: str, role: str) -> str:
    now_ts = int(time.time())
    payload = {
        'sub': username,
        'role': role,
        'iat': now_ts,
        'exp': now_ts + JWT_EXPIRE_SECONDS
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token.decode('utf-8') if isinstance(token, bytes) else token


def parse_bearer_token():
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:].strip()
    return token or None


def require_auth():
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not JWT_SECRET:
                return jsonify({'success': False, 'error': 'Server auth not configured'}), 500

            token = parse_bearer_token()
            if not token:
                return jsonify({'success': False, 'error': 'Unauthorized'}), 401

            try:
                claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
                g.current_user = {
                    'username': claims.get('sub', ''),
                    'role': claims.get('role', 'technician')
                }
            except jwt.ExpiredSignatureError:
                return jsonify({'success': False, 'error': 'Token expired'}), 401
            except jwt.InvalidTokenError:
                return jsonify({'success': False, 'error': 'Unauthorized'}), 401

            return func(*args, **kwargs)
        return wrapper
    return decorator

# Global variables
device = None
model = None
class_names = ['Hatchery', 'Natural']
ACTIVE_MODEL_VERSION = None  # Will be set after loading checkpoint

# FL normalization parameters
FL_APPROX_MEAN = 60.0
FL_APPROX_STD = 10.0

def normalize_fl(fl_value):
    """Normalize FL value"""
    return (fl_value - FL_APPROX_MEAN) / FL_APPROX_STD


def resolve_checkpoint_path():
    """
    Resolve checkpoint path from env/config defaults.

    Priority:
    1) CHECKPOINT_PATH env var (absolute or relative to project root)
    2) src.config.CHECKPOINT_PATH (absolute or relative to project root)
    3) project_root/best.ckpt
    4) legacy training output path (kept for backward compatibility)
    """
    env_path = os.getenv('CHECKPOINT_PATH')
    if env_path:
        p = Path(env_path)
        if not p.is_absolute():
            p = Path(project_root) / p
        return str(p)

    if CHECKPOINT_PATH:
        p = Path(CHECKPOINT_PATH)
        if not p.is_absolute():
            p = Path(project_root) / p
        return str(p)

    return str(Path(project_root) / "best.ckpt")

INFERENCE_TRANSFORM = transforms.Compose([
    transforms.Resize((IMG_SIZE, IMG_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(mean=NORMALIZE_MEAN, std=NORMALIZE_STD),
])


def preprocess_image(img_array):
    """Preprocess image using the same pipeline as training"""
    # Core preprocessing pipeline
    img_proc = preprocess_img_pipeline(img_array)  # H W 3, [0,1]
    
    # Convert to PIL RGB for torchvision transforms
    pil_img = Image.fromarray((img_proc * 255).astype(np.uint8), mode="RGB")
    
    img_tensor = INFERENCE_TRANSFORM(pil_img).unsqueeze(0)  # Add batch dimension
    return img_tensor

def grad_cam(model, image, tabular_features, device, target_class=None):
    """Generate Grad-CAM heatmap"""
    model.eval()
    
    # Find the last convolutional layer in image_features
    target_layer = None
    for name, module in model.named_modules():
        if isinstance(module, torch.nn.Conv2d):
            target_layer = name
    
    if target_layer is None:
        return None, None
    
    activations = {}
    gradients = {}
    
    def forward_hook(name):
        def hook(module, input, output):
            activations[name] = output.detach()
        return hook
    
    def backward_hook(name):
        def hook(module, grad_input, grad_output):
            gradients[name] = grad_output[0].detach()
        return hook
    
    # Register hooks
    handles = []
    for name, module in model.named_modules():
        if name == target_layer:
            handle_forward = module.register_forward_hook(forward_hook(name))
            handle_backward = module.register_full_backward_hook(backward_hook(name))
            handles = [handle_forward, handle_backward]
            break
    
    # Forward pass
    image = image.to(device)
    image.requires_grad = True
    
    output = model(image, tabular_features)
    
    if target_class is None:
        target_class = output.argmax(dim=1).item()
    
    # Backward pass
    model.zero_grad()
    output[0, target_class].backward()
    
    # Generate CAM
    if target_layer in gradients and target_layer in activations:
        grad = gradients[target_layer]
        act = activations[target_layer]
        
        # Global average pooling of gradients
        weights = grad.mean(dim=(2, 3), keepdim=True)
        
        # Weighted combination of activation maps
        cam = (weights * act).sum(dim=1, keepdim=True)
        cam = F.relu(cam)
        
        # Normalize
        cam = cam.squeeze().cpu().numpy()
        cam = (cam - cam.min()) / (cam.max() - cam.min() + 1e-8)
        
        # Resize to input size
        cam = cv2.resize(cam, (IMG_SIZE, IMG_SIZE))
        
        # Remove hooks
        for handle in handles:
            handle.remove()
        
        return cam, target_class
    
    # Remove hooks if failed
    for handle in handles:
        handle.remove()
    
    return None, None

def image_to_base64(img_array):
    """Convert image array to base64 PNG string"""
    pil_img = Image.fromarray(img_array)
    buffer = io.BytesIO()
    pil_img.save(buffer, format='PNG')
    img_str = base64.b64encode(buffer.getvalue()).decode('utf-8')
    return img_str

def overlay_heatmap(img_array, heatmap):
    """Overlay heatmap on image"""
    h, w = img_array.shape[:2]
    heatmap_resized = cv2.resize(heatmap, (w, h))
    
    # Convert heatmap to RGB
    heatmap_colored = cv2.applyColorMap((heatmap_resized * 255).astype(np.uint8), cv2.COLORMAP_JET)
    heatmap_colored = cv2.cvtColor(heatmap_colored, cv2.COLOR_BGR2RGB)
    
    # Overlay with alpha blending
    overlay = cv2.addWeighted(img_array, 0.6, heatmap_colored, 0.4, 0)
    return overlay

def _build_tabular_features(sex_values, fl_values, year_values=None):
    """Build tabular feature tensors on the active device."""
    if year_values is None:
        year_values = [0] * len(sex_values)

    return {
        'sex': torch.tensor(sex_values, dtype=torch.long).to(device),
        'fl': torch.tensor(fl_values, dtype=torch.float32).to(device),
        'year': torch.tensor(year_values, dtype=torch.long).to(device)
    }


def _elapsed_ms(start_ts):
    """Convert a perf_counter start timestamp to elapsed milliseconds."""
    return (time.perf_counter() - start_ts) * 1000.0


def _prepare_image_for_processing(job_id, image_data, generated_index=None):
    """
    Decode and preprocess one image, returning data needed for inference and storage.
    """
    import os
    prepare_start = time.perf_counter()

    # 1) Derive image_id from the original image name (stable across re-uploads)
    # Prefer request-provided filename; fallback to an autogenerated id if missing.
    original_filename = image_data.get('filename')
    if original_filename:
        original_filename = os.path.basename(str(original_filename))
        cleaned_filename = "".join(c for c in original_filename if c.isalnum() or c in ('_', '-', '.'))
        image_id = cleaned_filename
        base_name = os.path.splitext(cleaned_filename)[0]
    else:
        image_id = generate_image_id()
        if generated_index is None:
            current_num = get_job_num_images(job_id)
            generated_index = current_num + 1
        base_name = f"img_{generated_index:03d}"

    # 2) Decode image
    image_base64 = image_data.get('image')
    if not image_base64:
        raise ValueError('No image provided')

    image_bytes = base64.b64decode(image_base64)
    img_array = tiff.imread(io.BytesIO(image_bytes))

    # Convert to RGB if grayscale
    if img_array.ndim == 2:
        img_array = np.stack([img_array] * 3, axis=-1)
    elif img_array.ndim == 3 and img_array.shape[2] == 1:
        img_array = np.repeat(img_array, 3, axis=2)

    # Normalize to uint8 if needed
    if img_array.dtype != np.uint8:
        if img_array.max() > 1.0:
            img_array = (img_array / img_array.max() * 255).astype(np.uint8)
        else:
            img_array = (img_array * 255).astype(np.uint8)

    # 3) Tabular features
    sex = int(image_data.get('sex', 2))
    fl = float(image_data.get('fl', 60))
    fl_value = normalize_fl(fl)
    scale_id = str(image_data.get('scale_id', '') or '')

    # 4) Image tensor (CPU for batching; moved to device right before forward)
    img_tensor = preprocess_image(img_array)

    return {
        'image_id': image_id,
        'base_name': base_name,
        'img_array': img_array,
        'img_tensor': img_tensor,
        'sex': sex,
        'fl': fl,
        'fork_length': fl,
        'fl_value': fl_value,
        'scale_id': scale_id,
        'preprocess_ms': _elapsed_ms(prepare_start),
    }


def _run_single_inference(prepared):
    """Run one forward pass and return prediction metadata."""
    analysis_start = time.perf_counter()
    tabular_features = _build_tabular_features([prepared['sex']], [prepared['fl_value']])

    with torch.no_grad():
        output = model(prepared['img_tensor'].to(device), tabular_features)
        probabilities = F.softmax(output, dim=1)
        prediction = int(output.argmax(dim=1).item())
        confidence = float(probabilities[0, prediction].item())

    inference_ms = (time.perf_counter() - analysis_start) * 1000.0
    print(f"[TIMING] Inference time: {inference_ms:.2f} ms (image_id={prepared['image_id']})")

    return {
        'prediction': prediction,
        'confidence': confidence,
        'probabilities': [float(probabilities[0, 0].item()), float(probabilities[0, 1].item())],
        'tabular_features': tabular_features,
        'analysis_start': analysis_start,
        'inference_ms': inference_ms,
    }


def _run_batch_inference(prepared_items):
    """Run a single batched forward pass for multiple prepared images."""
    if not prepared_items:
        return []

    batch_start = time.perf_counter()
    batch_images = torch.cat([item['img_tensor'] for item in prepared_items], dim=0).to(device)
    batch_tabular = _build_tabular_features(
        [item['sex'] for item in prepared_items],
        [item['fl_value'] for item in prepared_items],
    )

    with torch.no_grad():
        output = model(batch_images, batch_tabular)
        probabilities = F.softmax(output, dim=1)
        predictions = output.argmax(dim=1)

    batch_inference_ms = (time.perf_counter() - batch_start) * 1000.0
    per_image_ms = batch_inference_ms / max(len(prepared_items), 1)
    print(
        f"[TIMING] Batch inference time: {batch_inference_ms:.2f} ms "
        f"for {len(prepared_items)} images (~{per_image_ms:.2f} ms/image)"
    )

    results = []
    for idx, item in enumerate(prepared_items):
        prediction = int(predictions[idx].item())
        confidence = float(probabilities[idx, prediction].item())
        results.append({
            'prediction': prediction,
            'confidence': confidence,
            'probabilities': [
                float(probabilities[idx, 0].item()),
                float(probabilities[idx, 1].item())
            ],
            # Keep a per-image tensor dict for Grad-CAM and downstream compatibility.
            'tabular_features': _build_tabular_features([item['sex']], [item['fl_value']]),
            'analysis_start': batch_start,
            'inference_ms': per_image_ms,
            'batch_inference_total_ms': batch_inference_ms,
        })
    return results


def _prepare_finalization_payload(job_id, prepared, inference_data):
    """
    Prepare per-image artifacts after inference: Grad-CAM + overlay + metadata.
    """
    image_id = prepared['image_id']
    base_name = prepared['base_name']
    img_array = prepared['img_array']
    sex = prepared['sex']
    fork_length = prepared['fork_length']
    img_tensor = prepared['img_tensor']
    scale_id = prepared.get('scale_id', '')

    prediction = inference_data['prediction']
    confidence = inference_data['confidence']
    probabilities = inference_data['probabilities']
    tabular_features = inference_data['tabular_features']
    inference_ms = float(inference_data.get('inference_ms', 0.0))

    # Generate Grad-CAM (timed)
    gradcam_start = time.perf_counter()
    heatmap, _ = grad_cam(model, img_tensor, tabular_features, device, target_class=prediction)
    gradcam_ms = (time.perf_counter() - gradcam_start) * 1000.0
    total_analysis_ms = inference_ms + gradcam_ms
    print(
        f"[TIMING] Grad-CAM time: {gradcam_ms:.2f} ms, "
        f"Total analysis time: {total_analysis_ms:.2f} ms (image_id={image_id})"
    )

    # Generate overlay image (only overlay, no separate heatmap)
    raw_image = img_array
    if heatmap is not None:
        overlay_image = overlay_heatmap(img_array, heatmap)
    else:
        overlay_image = img_array

    return {
        'job_id': job_id,
        'image_id': image_id,
        'base_name': base_name,
        'img_array': img_array,
        'overlay_image': overlay_image,
        'has_heatmap': heatmap is not None,
        'sex': sex,
        'fork_length': fork_length,
        'prediction': prediction,
        'confidence': float(confidence),
        'probabilities': probabilities,
        'scale_id': scale_id,
        'timing_ms': {
            'preprocess_ms': float(prepared.get('preprocess_ms', 0.0)),
            'inference_ms': inference_ms,
            'gradcam_ms': gradcam_ms,
            'analysis_total_ms': total_analysis_ms
        }
    }


def _persist_finalization_payload(payload, user_id=''):
    """
    Upload images, save DynamoDB item, and build the API response object.
    """
    persist_start = time.perf_counter()

    job_id = payload['job_id']
    image_id = payload['image_id']
    base_name = payload['base_name']
    img_array = payload['img_array']
    overlay_image = payload['overlay_image']
    has_heatmap = payload['has_heatmap']
    sex = payload['sex']
    fork_length = payload['fork_length']
    prediction = payload['prediction']
    confidence = payload['confidence']
    probabilities = payload['probabilities']
    scale_id = payload.get('scale_id', '')

    raw_key = f"{INFERENCE_S3_BASE_PREFIX}jobs/{job_id}/raw/{base_name}.tiff"
    overlay_key = f"{INFERENCE_S3_BASE_PREFIX}jobs/{job_id}/results/{base_name}_overlay.png"
    raw_display_key = f"{INFERENCE_S3_BASE_PREFIX}jobs/{job_id}/results/{base_name}_raw.png"
    timing_ms = dict(payload.get('timing_ms', {}))

    # Upload raw image (TIFF for download)
    raw_upload_start = time.perf_counter()
    raw_upload_success, raw_upload_error = upload_image_to_s3(
        img_array, INFERENCE_S3_BUCKET, raw_key, 'TIFF'
    )
    timing_ms['upload_raw_ms'] = _elapsed_ms(raw_upload_start)
    if not raw_upload_success:
        print(f"[ERROR] Failed to upload raw image to S3: {raw_upload_error}")
        print(f"[ERROR] S3 Key: {raw_key}, Bucket: {INFERENCE_S3_BUCKET}")
    else:
        print(f"[SUCCESS] Uploaded raw image to S3: {raw_key}")

    # Upload raw as PNG for in-browser display (browsers cannot display TIFF)
    raw_display_upload_start = time.perf_counter()
    raw_display_success, _ = upload_image_to_s3(
        img_array, INFERENCE_S3_BUCKET, raw_display_key, 'PNG'
    )
    timing_ms['upload_raw_display_ms'] = _elapsed_ms(raw_display_upload_start)
    if not raw_display_success:
        print(f"[WARN] Failed to upload raw display PNG to S3: {raw_display_key}")
    else:
        print(f"[SUCCESS] Uploaded raw display PNG to S3: {raw_display_key}")

    # Upload overlay image
    overlay_upload_start = time.perf_counter()
    overlay_upload_success, overlay_upload_error = upload_image_to_s3(
        overlay_image, INFERENCE_S3_BUCKET, overlay_key, 'PNG'
    )
    timing_ms['upload_overlay_ms'] = _elapsed_ms(overlay_upload_start)
    if not overlay_upload_success:
        print(f"[ERROR] Failed to upload overlay image to S3: {overlay_upload_error}")
        print(f"[ERROR] S3 Key: {overlay_key}, Bucket: {INFERENCE_S3_BUCKET}")
    else:
        print(f"[SUCCESS] Uploaded overlay image to S3: {overlay_key}")

    # Save to DynamoDB (no heatmap_key)
    ddb_start = time.perf_counter()
    db_success, db_error = save_image_item(
        job_id=job_id,
        image_id=image_id,
        raw_key=raw_key,
        overlay_key=overlay_key,
        pred_label=prediction,
        confidence=confidence,
        fork_length=fork_length,
        sex=sex,
        user_id=user_id,
        scale_id=scale_id
    )
    timing_ms['dynamodb_ms'] = _elapsed_ms(ddb_start)

    if not db_success:
        print(f"[ERROR] Failed to save to DynamoDB: {db_error}")
        print(f"[ERROR] Job ID: {job_id}, Image ID: {image_id}")
    else:
        print(
            f"[SUCCESS] Saved to DynamoDB: job_id={job_id}, image_id={image_id}, "
            f"confidence={confidence:.4f}, pred_label={prediction}"
        )

    # Check overall storage status
    s3_uploaded = raw_upload_success and overlay_upload_success

    serialization_start = time.perf_counter()
    original_image_base64 = image_to_base64(img_array)
    heatmap_image_base64 = image_to_base64(overlay_image) if has_heatmap else None
    timing_ms['serialization_ms'] = _elapsed_ms(serialization_start)
    timing_ms['persist_total_ms'] = _elapsed_ms(persist_start)
    timing_ms['image_e2e_ms'] = (
        float(timing_ms.get('preprocess_ms', 0.0))
        + float(timing_ms.get('inference_ms', 0.0))
        + float(timing_ms.get('gradcam_ms', 0.0))
        + float(timing_ms.get('persist_total_ms', 0.0))
    )

    return {
        'job_id': job_id,
        'image_id': image_id,
        'scale_id': scale_id,
        'prediction': prediction,
        'class_name': class_names[prediction],
        'confidence': float(confidence),
        'probabilities': probabilities,
        'original_image': original_image_base64,
        'heatmap_image': heatmap_image_base64,
        's3_keys': {
            'raw_key': raw_key,
            'overlay_key': overlay_key,
            'raw_display_key': raw_display_key,
        },
        'timing_ms': timing_ms,
        'storage_status': {
            's3_uploaded': s3_uploaded,
            'dynamodb_saved': db_success,
            'errors': {
                's3_raw_error': raw_upload_error if not raw_upload_success else None,
                's3_overlay_error': overlay_upload_error if not overlay_upload_success else None,
                'dynamodb_error': db_error if not db_success else None
            }
        }
    }


def _finalize_processed_image(job_id, prepared, inference_data, user_id=''):
    """
    Finish per-image processing after inference: Grad-CAM + upload + DB + response.
    """
    payload = _prepare_finalization_payload(job_id, prepared, inference_data)
    return _persist_finalization_payload(payload, user_id=user_id)


@app.route('/api/predict_preview', methods=['POST'])
@require_auth()
def predict_preview():
    """
    Lightweight prediction endpoint for Quick Check preview.

    - Accepts the same single-image payload as /api/predict but
      does NOT upload to S3 or write to DynamoDB.
    - Returns only prediction/class_name/confidence/probabilities.
    """
    try:
        data = request.get_json(silent=True) or {}
        if not data.get('image'):
            return jsonify({'error': 'No image provided'}), 400

        # Use a fixed dummy job_id; helpers only need it for preprocessing/inference
        job_id = "quick-check-preview"
        prepared = _prepare_image_for_processing(job_id, data)
        inference_data = _run_single_inference(prepared)

        prediction = inference_data['prediction']
        confidence = inference_data['confidence']
        probabilities = inference_data['probabilities']
        class_name = class_names[prediction] if 0 <= prediction < len(class_names) else str(prediction)

        return jsonify({
            'prediction': prediction,
            'class_name': class_name,
            'confidence': confidence,
            'probabilities': probabilities,
        }), 200
    except Exception as e:
        import traceback
        print(f"[ERROR] Preview prediction failed: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': 'Preview prediction failed. Please check your image format and try again.'}), 500


def process_single_image(job_id, image_data, user_id=''):
    """
    Process a single image: inference + upload to S3 + save to DynamoDB
    
    Parameters:
        job_id: Integer
        image_data: Dict with keys: image (base64), sex, fl, filename (optional)
        user_id: String (operator username)
    
    Returns:
        Dict with prediction results and metadata
    """
    single_start = time.perf_counter()
    prepared = _prepare_image_for_processing(job_id, image_data)
    inference_data = _run_single_inference(prepared)
    result = _finalize_processed_image(job_id, prepared, inference_data, user_id=user_id)
    timing_ms = dict(result.get('timing_ms', {}))
    timing_ms['image_e2e_ms'] = _elapsed_ms(single_start)
    result['timing_ms'] = timing_ms
    return result

@app.route('/')
def index():
    """Serve the HTML frontend"""
    return send_from_directory('.', 'predict_web.html')


@app.route('/api/signup', methods=['POST'])
def signup():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    role = (data.get('role') or '').strip().lower()
    role = role if role in ('technician', 'biologist') else 'biologist'

    if not username or not password:
        return jsonify({'success': False, 'error': 'username and password are required'}), 400
    if len(username) < 2:
        return jsonify({'success': False, 'error': 'username must be at least 2 characters'}), 400
    if len(password) < 4:
        return jsonify({'success': False, 'error': 'password must be at least 4 characters'}), 400

    users_table = get_users_table()
    now_ts = int(time.time())
    item = {
        'username': username,
        'password_hash': hash_password(password),
        'role': role,
        'status': 'active',
        'created_at': now_ts
    }
    try:
        users_table.put_item(
            Item=item,
            ConditionExpression='attribute_not_exists(username)'
        )
        return jsonify({'success': True}), 200
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return jsonify({'success': False, 'error': 'username already exists'}), 409
        print(f"[ERROR] Signup failed: {str(e)}")
        return jsonify({'success': False, 'error': 'signup failed'}), 500
    except Exception as e:
        print(f"[ERROR] Signup failed: {str(e)}")
        return jsonify({'success': False, 'error': 'signup failed'}), 500


@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if not username or not password:
        return jsonify({'success': False, 'error': 'username and password are required'}), 400
    if not JWT_SECRET:
        return jsonify({'success': False, 'error': 'Server auth not configured'}), 500

    try:
        users_table = get_users_table()
        resp = users_table.get_item(Key={'username': username}, ConsistentRead=True)
        user = resp.get('Item')
        if not user:
            return jsonify({'success': False, 'error': 'invalid credentials'}), 401
        if user.get('status') != 'active':
            return jsonify({'success': False, 'error': 'user is inactive'}), 401
        if not verify_password(password, user.get('password_hash', '')):
            return jsonify({'success': False, 'error': 'invalid credentials'}), 401

        role = user.get('role', 'technician')
        token = create_jwt(username=username, role=role)
        return jsonify({
            'success': True,
            'token': token,
            'user': {
                'username': username,
                'role': role
            }
        }), 200
    except Exception as e:
        print(f"[ERROR] Login failed: {str(e)}")
        return jsonify({'success': False, 'error': 'login failed'}), 500


@app.route('/api/me', methods=['GET'])
@require_auth()
def me():
    user = getattr(g, 'current_user', {}) or {}
    return jsonify({
        'success': True,
        'user': {
            'username': user.get('username', ''),
            'role': user.get('role', 'technician')
        }
    }), 200


@app.route('/api/logout', methods=['POST'])
@require_auth()
def logout():
    # JWT is stateless; frontend should discard token.
    return jsonify({'success': True}), 200


@app.route('/api/predict', methods=['POST'])
@require_auth()
def predict():
    """
    Unified API endpoint for prediction (supports single or batch images)
    
    Request format (single image - backward compatible):
    {
        "image": "base64_string",
        "sex": 0,
        "fl": 60.5,
        "filename": "803_2X.tif"  // Optional: original filename
    }
    
    Request format (batch images):
    {
        "images": [
            {"image": "base64_string1", "sex": 0, "fl": 60.5, "filename": "803_2X.tif"},
            {"image": "base64_string2", "sex": 1, "fl": 65.0, "filename": "805_2X.tif"}
        ],
        "job_id": "optional-existing-job-id",
        "user_id": "optional-user-id"
    }
    
    Note:
    - job_id format: UUID string (e.g., "550e8400-e29b-41d4-a716-446655440000")
    - If filename is provided, S3 keys will use original filename:
      - Raw: {filename_base}.tiff
      - Overlay: {filename_base}_overlay.png
    - If filename is not provided, uses sequence number: img_001, img_002, etc.
    """
    request_start = time.perf_counter()
    try:
        data = request.json
        
        # ========== Determine if single or batch mode ==========
        if 'images' in data:
            # Batch processing mode
            prepare_phase_start = time.perf_counter()
            images_data = data.get('images', [])
            if not images_data:
                return jsonify({'error': 'No images provided'}), 400
            
            # Get or create job_id
            current_user = getattr(g, 'current_user', {}) or {}
            user_id = current_user.get('username') or data.get('user_id') or 'anonymous'
            job_id = data.get('job_id')
            if not job_id:
                job_id = generate_job_id()
                raw_prefix = f"{INFERENCE_S3_BASE_PREFIX}jobs/{job_id}/raw/"
                result_prefix = f"{INFERENCE_S3_BASE_PREFIX}jobs/{job_id}/results/"
                create_job_meta(job_id, user_id, raw_prefix, result_prefix, ACTIVE_MODEL_VERSION or "unknown")
            
            # Process each image
            results = [None] * len(images_data)
            successful_count = 0
            failed_count = 0

            prepared_items = []
            next_generated_index = get_job_num_images(job_id) + 1

            for idx, img_data in enumerate(images_data):
                image_pipeline_start = time.perf_counter()
                try:
                    # Ensure filename is included if provided
                    if 'filename' not in img_data:
                        img_data['filename'] = None

                    print(f"[INFO] Preparing image {idx + 1}/{len(images_data)}: {img_data.get('filename', 'unknown')}")
                    generated_index = None
                    if not img_data.get('filename'):
                        generated_index = next_generated_index
                        next_generated_index += 1

                    prepared = _prepare_image_for_processing(
                        job_id,
                        img_data,
                        generated_index=generated_index
                    )
                    prepared['batch_index'] = idx
                    prepared['pipeline_start'] = image_pipeline_start
                    prepared_items.append(prepared)
                except Exception as e:
                    import traceback
                    print(f"[ERROR] Failed to prepare image {idx + 1}: {str(e)}")
                    traceback.print_exc()
                    failed_count += 1
                    results[idx] = {
                        'error': str(e),
                        'image_id': None,
                        'timing_ms': {
                            'image_e2e_ms': _elapsed_ms(image_pipeline_start)
                        },
                        'storage_status': {
                            's3_uploaded': False,
                            'dynamodb_saved': False,
                            'errors': {'processing_error': str(e)}
                        }
                    }

            # One batched forward pass for all successfully prepared images
            batch_infer_phase_start = time.perf_counter()
            batch_inference_results = _run_batch_inference(prepared_items)
            batch_infer_phase_ms = _elapsed_ms(batch_infer_phase_start)

            io_max_workers = max(1, min(len(prepared_items), int(os.getenv('BATCH_IO_WORKERS', '4')))) if prepared_items else 1
            persist_futures = {}

            with ThreadPoolExecutor(max_workers=io_max_workers) as executor:
                for prepared, inference_data in zip(prepared_items, batch_inference_results):
                    idx = prepared['batch_index']
                    try:
                        print(
                            f"[INFO] Generating Grad-CAM for image {idx + 1}/{len(images_data)}: "
                            f"{prepared['image_id']}"
                        )
                        payload = _prepare_finalization_payload(job_id, prepared, inference_data)
                        future = executor.submit(_persist_finalization_payload, payload, user_id)
                        persist_futures[future] = (idx, prepared.get('image_id'), prepared.get('pipeline_start'))
                    except Exception as e:
                        import traceback
                        print(f"[ERROR] Failed before upload for image {idx + 1}: {str(e)}")
                        traceback.print_exc()
                        failed_count += 1
                        results[idx] = {
                            'error': str(e),
                            'image_id': prepared.get('image_id'),
                            'timing_ms': {
                                'preprocess_ms': float(prepared.get('preprocess_ms', 0.0)),
                                'inference_ms': float(inference_data.get('inference_ms', 0.0)),
                                'image_e2e_ms': _elapsed_ms(prepared.get('pipeline_start', image_pipeline_start)),
                            },
                            'storage_status': {
                                's3_uploaded': False,
                                'dynamodb_saved': False,
                                'errors': {'processing_error': str(e)}
                            }
                        }

                for future in as_completed(persist_futures):
                    idx, image_id, pipeline_start = persist_futures[future]
                    try:
                        result = future.result()
                        timing_ms = dict(result.get('timing_ms', {}))
                        if pipeline_start:
                            timing_ms['image_e2e_ms'] = _elapsed_ms(pipeline_start)
                        result['timing_ms'] = timing_ms

                        storage_status = result.get('storage_status', {})
                        s3_ok = storage_status.get('s3_uploaded', False)
                        db_ok = storage_status.get('dynamodb_saved', False)

                        if not s3_ok:
                            print(f"[WARNING] Image {idx + 1} S3 upload failed: {storage_status.get('errors', {}).get('s3_raw_error') or storage_status.get('errors', {}).get('s3_overlay_error')}")
                        if not db_ok:
                            print(f"[WARNING] Image {idx + 1} DynamoDB save failed: {storage_status.get('errors', {}).get('dynamodb_error')}")

                        if s3_ok and db_ok:
                            successful_count += 1
                            print(f"[SUCCESS] Image {idx + 1} saved successfully to S3 and DynamoDB")
                        else:
                            failed_count += 1
                            print(f"[WARNING] Image {idx + 1} had storage issues (S3: {s3_ok}, DB: {db_ok})")

                        results[idx] = result
                    except Exception as e:
                        import traceback
                        print(f"[ERROR] Failed to persist image {idx + 1}: {str(e)}")
                        traceback.print_exc()
                        failed_count += 1
                        results[idx] = {
                            'error': str(e),
                            'image_id': image_id,
                            'timing_ms': {
                                'image_e2e_ms': _elapsed_ms(pipeline_start) if pipeline_start else 0.0
                            },
                            'storage_status': {
                                's3_uploaded': False,
                                'dynamodb_saved': False,
                                'errors': {'processing_error': str(e)}
                            }
                        }
            
            # Update job meta count (only count successful saves)
            update_job_meta_num_images(job_id, successful_count)

            request_total_ms = _elapsed_ms(request_start)
            prepare_phase_ms = _elapsed_ms(prepare_phase_start)
            e2e_values = [
                float(r.get('timing_ms', {}).get('image_e2e_ms', 0.0))
                for r in results if r and isinstance(r, dict) and r.get('timing_ms')
            ]
            avg_image_e2e_ms = (sum(e2e_values) / len(e2e_values)) if e2e_values else 0.0
            
            print(f"[SUMMARY] Batch processing complete: {successful_count} successful, {failed_count} failed out of {len(images_data)} total")
            print(
                f"[TIMING] Request E2E: {request_total_ms:.2f} ms "
                f"(mode=batch, images={len(images_data)}, prepare_phase={prepare_phase_ms:.2f} ms, "
                f"inference_phase={batch_infer_phase_ms:.2f} ms, avg_image_e2e={avg_image_e2e_ms:.2f} ms)"
            )
            
            return jsonify({
                'job_id': job_id,
                'user_id': user_id,
                'num_images': len(results),
                'successful_count': successful_count,
                'failed_count': failed_count,
                'results': results,
                'request_timing_ms': {
                    'request_e2e_ms': request_total_ms,
                    'prepare_phase_ms': prepare_phase_ms,
                    'inference_phase_ms': batch_infer_phase_ms,
                    'avg_image_e2e_ms': avg_image_e2e_ms
                }
            })
        
        else:
            # Single image mode (backward compatible)
            # Convert to batch format (batch_size=1)
            single_image_data = {
                'image': data.get('image'),
                'sex': data.get('sex', 2),
                'fl': data.get('fl', 60),
                'filename': data.get('filename')  # Optional: original filename
            }
            
            if not single_image_data.get('image'):
                return jsonify({'error': 'No image provided'}), 400
            
            # Create new job (single image also creates a job)
            job_id = generate_job_id()
            current_user = getattr(g, 'current_user', {}) or {}
            user_id = current_user.get('username') or data.get('user_id') or 'anonymous'
            raw_prefix = f"{INFERENCE_S3_BASE_PREFIX}jobs/{job_id}/raw/"
            result_prefix = f"{INFERENCE_S3_BASE_PREFIX}jobs/{job_id}/results/"
            create_job_meta(job_id, user_id, raw_prefix, result_prefix, ACTIVE_MODEL_VERSION or "unknown")
            
            # Process single image
            result = process_single_image(job_id, single_image_data, user_id=user_id)
            
            # Update job meta
            update_job_meta_num_images(job_id, 1)
            
            request_total_ms = _elapsed_ms(request_start)
            print(
                f"[TIMING] Request E2E: {request_total_ms:.2f} ms "
                f"(mode=single, image_id={result.get('image_id')}, image_e2e={result.get('timing_ms', {}).get('image_e2e_ms', 0.0):.2f} ms)"
            )

            # Return single image format (backward compatible)
            return jsonify({
                'job_id': job_id,
                'user_id': user_id,
                'image_id': result['image_id'],
                'prediction': result['prediction'],
                'class_name': result['class_name'],
                'confidence': result['confidence'],
                'probabilities': result['probabilities'],
                'original_image': result['original_image'],
                'heatmap_image': result['heatmap_image'],
                's3_keys': result['s3_keys'],
                'timing_ms': result.get('timing_ms', {}),
                'request_timing_ms': {
                    'request_e2e_ms': request_total_ms
                },
                'storage_status': result.get('storage_status', {})
            })
        
    except Exception as e:
        import traceback
        print(f"[ERROR] Prediction failed: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': 'Prediction failed. Please check your image format and try again.'}), 500

@app.route('/api/results', methods=['GET'])
@require_auth()
def get_results():
    """
    Get all inference results from DynamoDB (same format as /api/history)
    
    Returns:
        JSON array of result items, each containing:
        - job_id: String
        - image_id: String
        - confidence: Float
        - pred_label: Integer (0=Hatchery, 1=Natural)
        - review_status: String (pending, reviewed, approved)
        - created_at: String (ISO format)
        - raw_key: String (S3 key for raw image)
        - overlay_key: String (S3 key for overlay image)
    """
    try:
        # Fetch all history data (no limits for /api/results)
        history_data = get_all_history_data(limit_jobs=None, limit_images_per_job=None)
        
        if history_data is None:
            return jsonify([]), 200
        
        # Format the data as a simple array with only required fields (same as /api/history)
        result = []
        
        # Flatten images with job info
        for job in history_data['jobs']:
            job_id = job['job_id']
            images = history_data['images_by_job'].get(job_id, [])
            for image in images:
                # Prefer user_id from image record, fall back to job-level
                user_id = image.get('user_id', '') or job.get('user_id', '')
                image_item = {
                    'job_id': job_id,
                    'image_id': image.get('image_id', ''),
                    'scale_id': image.get('scale_id', ''),
                    'user_id': user_id,
                    'confidence': float(image.get('confidence', 0.0)),
                    'pred_label': int(image.get('pred_label', 0)),
                    'review_status': image.get('review_status', 'pending'),
                    'submitted_to_lab': bool(image.get('submitted_to_lab', False)),
                    'created_at': image.get('created_at', ''),
                    'updated_at': image.get('updated_at', ''),
                    'raw_key': image.get('raw_key', ''),
                    'overlay_key': image.get('overlay_key', ''),
                    'reader_name': image.get('reader_name', ''),
                    'manual_read_origin': image.get('manual_read_origin', ''),
                    'reviewer_id': image.get('reviewer_id', ''),
                    'field_acknowledged_at': image.get('field_acknowledged_at') or None,
                    'field_acknowledged_by': image.get('field_acknowledged_by') or None
                }
                result.append(image_item)
        
        return jsonify(result), 200
    except Exception as e:
        import traceback
        error_msg = str(e)
        traceback.print_exc()
        print(f"[ERROR] Failed to retrieve results: {error_msg}")
        # Return empty array instead of error for graceful degradation
        return jsonify([]), 200

@app.route('/api/history', methods=['GET'])
@require_auth()
def get_history():
    """
    Get history data from DynamoDB
    
    Query parameters:
        - limit_jobs: Maximum number of jobs to return (default: 50)
        - limit_images: Maximum number of images per job (default: 1000)
    
    Returns:
        Array of image objects with the following structure:
        [
          {
            "job_id": "string",
            "image_id": "string",
            "confidence": 0.95,
            "pred_label": 0,
            "review_status": "pending",
            "created_at": "2026-01-29T12:34:56.789Z",
            "raw_key": "string",
            "overlay_key": "string"
          }
        ]
    """
    try:
        # Allow None to fetch all data
        limit_jobs_param = request.args.get('limit_jobs')
        limit_images_param = request.args.get('limit_images')
        
        limit_jobs = int(limit_jobs_param) if limit_jobs_param else None
        limit_images = int(limit_images_param) if limit_images_param else None
        
        # Default to None (fetch all) if not specified
        history_data = get_all_history_data(limit_jobs=limit_jobs, limit_images_per_job=limit_images)
        
        # Format the data as a simple array with only required fields
        result = []
        
        # Flatten images with job info
        for job in history_data['jobs']:
            job_id = job['job_id']
            images = history_data['images_by_job'].get(job_id, [])
            for image in images:
                # Prefer user_id from image record, fall back to job-level
                user_id = image.get('user_id', '') or job.get('user_id', '')
                image_item = {
                    'job_id': job_id,
                    'image_id': image.get('image_id', ''),
                    'scale_id': image.get('scale_id', ''),
                    'user_id': user_id,
                    'confidence': float(image.get('confidence', 0.0)),
                    'pred_label': int(image.get('pred_label', 0)),
                    'review_status': image.get('review_status', 'pending'),
                    'submitted_to_lab': bool(image.get('submitted_to_lab', False)),
                    'created_at': image.get('created_at', ''),
                    'updated_at': image.get('updated_at', ''),
                    'raw_key': image.get('raw_key', ''),
                    'overlay_key': image.get('overlay_key', ''),
                    'reader_name': image.get('reader_name', ''),
                    'manual_read_origin': image.get('manual_read_origin', ''),
                    'reviewer_id': image.get('reviewer_id', ''),
                    'field_acknowledged_at': image.get('field_acknowledged_at') or None,
                    'field_acknowledged_by': image.get('field_acknowledged_by') or None
                }
                result.append(image_item)
        
        # Sort images by created_at descending (newest first)
        result.sort(key=lambda x: x.get('created_at', ''), reverse=True)
        
        return jsonify(result)
    except Exception as e:
        import traceback
        print(f"[ERROR] Failed to get history: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': f'Failed to get history: {str(e)}'}), 500

@app.route('/api/delete-history', methods=['DELETE', 'POST'])
@require_auth()
def delete_history_items():
    """
    Delete one or more history records.
    Body: { "items": [{"job_id": "...", "image_id": "..."}, ...] }
    """
    try:
        data = request.get_json()
        if not data or 'items' not in data:
            return jsonify({'error': 'Missing items list'}), 400

        items = data['items']
        if not isinstance(items, list) or len(items) == 0:
            return jsonify({'error': 'items must be a non-empty list'}), 400

        results = []
        for item in items:
            job_id = (item.get('job_id') or '').strip()
            image_id = (item.get('image_id') or '').strip()
            if not job_id or not image_id:
                results.append({'job_id': job_id, 'image_id': image_id, 'success': False, 'error': 'Missing job_id or image_id'})
                continue
            success, error = delete_image_item(job_id, image_id)
            results.append({'job_id': job_id, 'image_id': image_id, 'success': success, 'error': error})

        failed = [r for r in results if not r['success']]
        return jsonify({'deleted': len(results) - len(failed), 'failed': len(failed), 'results': results}), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/submit-to-lab', methods=['POST'])
@require_auth()
def submit_to_lab():
    """
    Mark selected images as submitted to lab for manual review.
    Only submitted images will trigger the lab notification and appear in Manual Review.

    Request body (JSON):
        { "images": [{"job_id": "...", "image_id": "..."}, ...] }
    """
    try:
        data = request.get_json() or {}
        image_list = data.get('images', [])

        if not image_list:
            return jsonify({'success': False, 'error': 'No images provided'}), 400

        from src.aws_utils import submit_images_to_lab
        success_count, errors = submit_images_to_lab(image_list)

        return jsonify({
            'success': True,
            'submitted': success_count,
            'errors': errors
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/update-review', methods=['PUT'])
@require_auth()
def update_review():
    """
    Update manual review fields for an image record.

    Request body (JSON):
        - job_id: String (required)
        - image_id: String (required)
        - reader_name: String (optional)
        - manual_read_origin: String (optional, 'Hatchery' or 'Wild')
        - review_status: String (optional)
    """
    try:
        data = request.get_json() or {}
        job_id = (data.get('job_id') or '').strip()
        image_id = (data.get('image_id') or '').strip()

        if not job_id or not image_id:
            return jsonify({'success': False, 'error': 'job_id and image_id are required'}), 400

        reader_name = data.get('reader_name')
        manual_read_origin = data.get('manual_read_origin')
        review_status = data.get('review_status')
        reviewer_id = g.current_user.get('username', '')

        from src.aws_utils import update_review_item
        success, error = update_review_item(
            job_id=job_id,
            image_id=image_id,
            reader_name=reader_name,
            manual_read_origin=manual_read_origin,
            review_status=review_status,
            reviewer_id=reviewer_id
        )

        if success:
            return jsonify({'success': True})
        else:
            return jsonify({'success': False, 'error': error}), 500
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/acknowledge-history', methods=['POST'])
@require_auth()
def acknowledge_history():
    """
    Mark one or more history items as acknowledged by field (clears "new confirmed" highlight).
    Body: { "items": [ { "job_id": "...", "image_id": "..." }, ... ] }
    """
    try:
        data = request.get_json() or {}
        items = data.get('items') or []
        if not items:
            return jsonify({'success': False, 'error': 'items array is required'}), 400
        username = g.current_user.get('username', '') or ''
        success_count = 0
        errors = []
        for entry in items:
            job_id = (entry.get('job_id') or '').strip()
            image_id = (entry.get('image_id') or '').strip()
            if not job_id or not image_id:
                errors.append('Missing job_id or image_id')
                continue
            ok, err = acknowledge_for_field(job_id, image_id, user_id=username or None)
            if ok:
                success_count += 1
            else:
                errors.append(f'{job_id}/{image_id}: {err}')
        return jsonify({'success': True, 'acknowledged': success_count, 'errors': errors if errors else None})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/image-url', methods=['GET'])
@require_auth()
def get_image_url():
    """
    Generate presigned URL for S3 image
    
    Query parameters:
        - s3_key: S3 object key (required)
        - expiration: URL expiration time in seconds (default: 3600)
    
    Returns:
        JSON object with 'url' field containing the presigned URL
    """
    try:
        s3_key = request.args.get('s3_key')
        if not s3_key:
            return jsonify({'error': 's3_key parameter is required'}), 400
        
        expiration = request.args.get('expiration', type=int, default=3600)
        
        # Initialize S3 client
        aws_access_key_id = os.getenv('AWS_ACCESS_KEY_ID')
        aws_secret_access_key = os.getenv('AWS_SECRET_ACCESS_KEY')
        
        if aws_access_key_id and aws_secret_access_key:
            s3_client = boto3.client(
                's3',
                region_name=AWS_REGION,
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key
            )
        else:
            s3_client = boto3.client('s3', region_name=AWS_REGION)
        
        # Generate presigned URL
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': INFERENCE_S3_BUCKET,
                'Key': s3_key
            },
            ExpiresIn=expiration
        )
        
        return jsonify({'url': url}), 200
    except Exception as e:
        import traceback
        print(f"[ERROR] Failed to generate presigned URL: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': f'Failed to generate image URL: {str(e)}'}), 500


@app.route('/api/image', methods=['GET'])
def get_image():
    """
    Return image bytes from S3. If the object is TIFF, convert to PNG so browsers can display it.
    Used by Manual Review to show original image when raw_display_key (PNG) does not exist (old data).
    Query parameters:
        - s3_key: S3 object key (required)
    Returns:
        Image bytes (PNG for TIFF input, otherwise as stored) with appropriate Content-Type.
    """
    try:
        s3_key = request.args.get('s3_key')
        if not s3_key:
            return jsonify({'error': 's3_key parameter is required'}), 400

        aws_access_key_id = os.getenv('AWS_ACCESS_KEY_ID')
        aws_secret_access_key = os.getenv('AWS_SECRET_ACCESS_KEY')
        if aws_access_key_id and aws_secret_access_key:
            s3_client = boto3.client(
                's3',
                region_name=AWS_REGION,
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key
            )
        else:
            s3_client = boto3.client('s3', region_name=AWS_REGION)

        resp = s3_client.get_object(Bucket=INFERENCE_S3_BUCKET, Key=s3_key)
        body_bytes = resp['Body'].read()
        key_lower = s3_key.lower()

        if key_lower.endswith('.tiff') or key_lower.endswith('.tif'):
            buf = io.BytesIO(body_bytes)
            arr = tiff.imread(buf)
            if arr.ndim == 2:
                if arr.dtype != np.uint8:
                    if arr.max() > 1.0:
                        arr = (arr / arr.max() * 255).astype(np.uint8)
                    else:
                        arr = (arr * 255).astype(np.uint8)
                pil_img = Image.fromarray(arr)
            elif arr.ndim == 3:
                if arr.shape[2] == 1:
                    arr = np.squeeze(arr, axis=2)
                if arr.dtype != np.uint8:
                    if arr.max() > 1.0:
                        arr = (arr / arr.max() * 255).astype(np.uint8)
                    else:
                        arr = (arr * 255).astype(np.uint8)
                pil_img = Image.fromarray(arr)
            else:
                return jsonify({'error': 'Unsupported TIFF format'}), 400
            png_buf = io.BytesIO()
            pil_img.save(png_buf, format='PNG')
            png_buf.seek(0)
            return Response(png_buf.getvalue(), mimetype='image/png')
        elif key_lower.endswith('.png'):
            return Response(body_bytes, mimetype='image/png')
        elif key_lower.endswith(('.jpg', '.jpeg')):
            return Response(body_bytes, mimetype='image/jpeg')
        else:
            return Response(body_bytes, mimetype='application/octet-stream')
    except Exception as e:
        import traceback
        try:
            from botocore.exceptions import ClientError
            if isinstance(e, ClientError) and e.response.get('Error', {}).get('Code') == 'NoSuchKey':
                return jsonify({'error': 'Image not found'}), 404
        except Exception:
            pass
        print(f"[ERROR] Failed to get image: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': f'Failed to get image: {str(e)}'}), 500


@app.route('/api/presign-upload', methods=['POST'])
@require_auth()
def presign_upload():
    """
    Generate presigned URL for S3 file upload (PUT)
    
    This endpoint allows frontend to upload files directly to S3 without exposing AWS credentials.
    Follows AWS best practices: frontend gets temporary presigned URL from backend.
    
    Request body:
        {
            "filename": "example.tif",  # Original filename (required)
            "content_type": "image/tiff",  # Optional, defaults to "application/octet-stream"
            "expiration": 3600,  # Optional, defaults to 1 hour (seconds)
            "prefix": "raw"  # Optional, defaults to "raw" (subfolder in job directory)
        }
    
    Returns:
        {
            "url": "https://s3.amazonaws.com/...",  # Presigned PUT URL
            "key": "inference-results/jobs/{job_id}/raw/example.tif",  # S3 key
            "job_id": "uuid",  # Generated job ID
            "image_id": "uuid",  # Generated image ID
            "expires_in": 3600  # Expiration time in seconds
        }
    
    Error responses:
        400: Missing required fields
        500: Failed to generate presigned URL
    """
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Request body is required'}), 400
        
        filename = data.get('filename')
        if not filename:
            return jsonify({'error': 'filename is required'}), 400
        
        # Optional parameters with defaults
        content_type = data.get('content_type', 'application/octet-stream')
        expiration = data.get('expiration', 3600)  # 1 hour default
        prefix = data.get('prefix', 'raw')  # Default to 'raw' folder
        
        # Generate job_id and image_id for the upload
        job_id = str(uuid.uuid4())
        image_id = str(uuid.uuid4())
        
        # Sanitize filename to prevent path traversal
        safe_filename = os.path.basename(filename)  # Remove any path components
        
        # Construct S3 key: inference-results/jobs/{job_id}/{prefix}/{filename}
        s3_key = f"{INFERENCE_S3_BASE_PREFIX}{INFERENCE_S3_PREFIX}{job_id}/{prefix}/{safe_filename}"
        
        # Initialize S3 client (uses IAM role if on EC2, or credentials from env/aws config)
        aws_access_key_id = os.getenv('AWS_ACCESS_KEY_ID')
        aws_secret_access_key = os.getenv('AWS_SECRET_ACCESS_KEY')
        
        if aws_access_key_id and aws_secret_access_key:
            s3_client = boto3.client(
                's3',
                region_name=AWS_REGION,
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key
            )
        else:
            # Use IAM role (recommended for EC2) or ~/.aws/credentials
            s3_client = boto3.client('s3', region_name=AWS_REGION)
        
        # Generate presigned PUT URL
        presigned_url = s3_client.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': INFERENCE_S3_BUCKET,
                'Key': s3_key,
                'ContentType': content_type
            },
            ExpiresIn=expiration
        )
        
        return jsonify({
            'url': presigned_url,
            'key': s3_key,
            'job_id': job_id,
            'image_id': image_id,
            'expires_in': expiration
        }), 200
        
    except Exception as e:
        import traceback
        print(f"[ERROR] Failed to generate presigned upload URL: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': f'Failed to generate upload URL: {str(e)}'}), 500

def load_model():
    """Load the trained model"""
    global device, model, ACTIVE_MODEL_VERSION
    
    print("Loading model...")
    device = get_device()
    
    checkpoint_path = resolve_checkpoint_path()
    if not os.path.exists(checkpoint_path):
        # Fallback to older location if needed
        legacy_path = os.path.join(project_root, "results/simple_multimodal_cnn_20251201_214610/checkpoints/best.ckpt")
        if os.path.exists(legacy_path):
            checkpoint_path = legacy_path

    if not os.path.exists(checkpoint_path):
        raise FileNotFoundError(
            "Checkpoint not found. Set CHECKPOINT_PATH or update src/config.py CHECKPOINT_PATH. "
            f"Resolved path: {checkpoint_path}"
        )

    # Use checkpoint filename as model version (saved into DynamoDB job meta)
    ACTIVE_MODEL_VERSION = os.path.basename(checkpoint_path)
    
    # Create model matching the latest 6-layer architecture with adaptive pooling
    # dropout_rate=0.4 matches the latest training configuration
    model = create_simple_multimodal_cnn(num_classes=2, dropout_rate=0.4, use_year=False, num_layers=6)
    model.load_state_dict(torch.load(checkpoint_path, map_location=device))
    model = model.to(device)
    model.eval()
    
    print(f"✅ Model loaded from: {checkpoint_path}")
    print(f"✅ Device: {device}")

if __name__ == '__main__':
    print("=" * 60)
    print("Fish Origin Classification API Server")
    print("=" * 60)
    
    # Load model
    load_model()
    
    # Security settings
    debug_mode = os.getenv('FLASK_DEBUG', 'False').lower() == 'true'
    host = os.getenv('FLASK_HOST', '127.0.0.1')  # Default to localhost only
    port = int(os.getenv('FLASK_PORT', '5001'))  # Changed to 5001 to avoid macOS AirPlay conflict
    
    if debug_mode:
        print("⚠️  WARNING: Debug mode is enabled! DO NOT use in production!")
    
    print(f"\n🚀 Starting Flask server...")
    print(f"📱 Access: http://{host}:{port}")
    print(f"🔒 Security: Debug={debug_mode}, Host={host}")
    print("=" * 60)
    
    # Run Flask app
    app.run(host=host, port=port, debug=debug_mode)
