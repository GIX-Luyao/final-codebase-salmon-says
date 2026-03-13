"""
AWS utility functions for S3 and DynamoDB operations
"""
import os
import boto3
import uuid
from datetime import datetime, timezone
from io import BytesIO
from PIL import Image
import numpy as np
from src.aws_config import (
    INFERENCE_S3_BUCKET,
    INFERENCE_S3_BASE_PREFIX,
    DYNAMODB_TABLE_NAME,
    AWS_REGION,
    MODEL_VERSION
)

# Initialize AWS clients with credentials from environment variables
aws_access_key_id = os.getenv('AWS_ACCESS_KEY_ID')
aws_secret_access_key = os.getenv('AWS_SECRET_ACCESS_KEY')

if aws_access_key_id and aws_secret_access_key:
    s3_client = boto3.client(
        's3',
        region_name=AWS_REGION,
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key
    )
    dynamodb_client = boto3.client(
        'dynamodb',
        region_name=AWS_REGION,
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key
    )
else:
    # Fallback to default credentials (from ~/.aws/credentials or IAM role)
    s3_client = boto3.client('s3', region_name=AWS_REGION)
    dynamodb_client = boto3.client('dynamodb', region_name=AWS_REGION)


def generate_job_id():
    """
    Generate unique job ID using UUID format.

    Why UUID?
    - Guarantees uniqueness (no collisions across users / concurrent uploads)
    - Works naturally with DynamoDB partition key type String ("S")
    """
    return str(uuid.uuid4())


def generate_image_id():
    """Generate unique image ID"""
    return str(uuid.uuid4())

def _job_id_attr(job_id):
    """Build DynamoDB attribute value for job_id (stored as String)."""
    return {'S': str(job_id)}


def upload_image_to_s3(image_array, bucket_name, s3_key, image_format='PNG'):
    """
    Upload image to S3
    
    Parameters:
        image_array: numpy array
        bucket_name: String
        s3_key: String
        image_format: 'PNG', 'JPEG', or 'TIFF'
    
    Returns:
        (success: Boolean, error: String or None)
    """
    try:
        pil_image = Image.fromarray(image_array)
        image_buffer = BytesIO()
        
        if image_format == 'TIFF':
            pil_image.save(image_buffer, format='TIFF')
            content_type = 'image/tiff'
        elif image_format == 'JPEG':
            pil_image.save(image_buffer, format='JPEG')
            content_type = 'image/jpeg'
        else:  # PNG
            pil_image.save(image_buffer, format='PNG')
            content_type = 'image/png'
        
        image_buffer.seek(0)
        
        s3_client.upload_fileobj(
            image_buffer,
            bucket_name,
            s3_key,
            ExtraArgs={'ContentType': content_type}
        )
        
        return True, None
    except Exception as e:
        return False, str(e)


def create_job_meta(job_id, user_id, raw_prefix, result_prefix, model_version):
    """
    Create job meta item in DynamoDB
    
    Parameters:
        job_id: String or Integer (Partition Key - String type in DynamoDB)
        user_id: String
        raw_prefix: String (S3 prefix for raw images)
        result_prefix: String (S3 prefix for result images)
        model_version: String
    
    Returns:
        (success: Boolean, error: String or None)
    """
    try:
        now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
        
        item = {
            'job_id': _job_id_attr(job_id),  # Partition Key (String type)
            'image_id': {'S': 'meta'},  # Sort Key (fixed value "meta")
            'user_id': {'S': user_id},
            'status': {'S': 'processing'},  # processing, completed, failed
            'created_at': {'S': now},
            'updated_at': {'S': now},
            'raw_prefix': {'S': raw_prefix},
            'result_prefix': {'S': result_prefix},
            'model_version': {'S': model_version},
            'num_images': {'N': '0'}  # Initial count, will be updated
        }
        
        dynamodb_client.put_item(
            TableName=DYNAMODB_TABLE_NAME,
            Item=item
        )
        
        return True, None
    except Exception as e:
        return False, str(e)


def save_image_item(job_id, image_id, raw_key, overlay_key,
                    pred_label, confidence, fork_length, sex, user_id='', scale_id=''):
    """
    Save image item to DynamoDB
    
    Parameters:
        job_id: String or Integer (Partition Key - String type in DynamoDB)
        image_id: String (Sort Key)
        raw_key: String (S3 key for raw image)
        overlay_key: String (S3 key for overlay image)
        pred_label: Integer (0 or 1)
        confidence: Float
        fork_length: Float
        sex: Integer
        user_id: String (operator username, optional)
        scale_id: String (scale ID from CSV, optional)
    
    Returns:
        (success: Boolean, error: String or None)
    """
    try:
        now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
        
        item = {
            'job_id': _job_id_attr(job_id),  # Partition Key (String type)
            'image_id': {'S': image_id},  # Sort Key
            'raw_key': {'S': raw_key},
            'overlay_key': {'S': overlay_key},
            'pred_label': {'N': str(pred_label)},
            'confidence': {'N': str(confidence)},
            'fork_length': {'N': str(fork_length)},
            'sex': {'N': str(sex)},
            'user_id': {'S': user_id or ''},  # operator username
            'scale_id': {'S': scale_id or ''},  # scale ID from CSV
            'review_status': {'S': 'pending'},  # pending, reviewed, approved
            'submitted_to_lab': {'BOOL': False},  # True only after operator explicitly commits
            'created_at': {'S': now},
            'updated_at': {'S': now}
        }
        
        # Optional fields (can be updated later)
        # override_label, note will be added via UpdateItem when needed
        
        dynamodb_client.put_item(
            TableName=DYNAMODB_TABLE_NAME,
            Item=item
        )
        
        return True, None
    except Exception as e:
        return False, str(e)


def submit_images_to_lab(image_list):
    """
    Mark a list of images as submitted to lab for review.

    Parameters:
        image_list: List of dicts with 'job_id' and 'image_id' keys

    Returns:
        (success_count: int, errors: list)
    """
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
    success_count = 0
    errors = []

    for item in image_list:
        job_id = item.get('job_id', '')
        image_id = item.get('image_id', '')
        if not job_id or not image_id:
            errors.append(f'Missing job_id or image_id: {item}')
            continue
        try:
            dynamodb_client.update_item(
                TableName=DYNAMODB_TABLE_NAME,
                Key={
                    'job_id': _job_id_attr(job_id),
                    'image_id': {'S': image_id}
                },
                UpdateExpression='SET submitted_to_lab = :val, updated_at = :now',
                ExpressionAttributeValues={
                    ':val': {'BOOL': True},
                    ':now': {'S': now}
                }
            )
            success_count += 1
        except Exception as e:
            errors.append(f'{job_id}/{image_id}: {str(e)}')

    return success_count, errors


def update_review_item(job_id, image_id, reader_name=None, manual_read_origin=None,
                       review_status=None, reviewer_id=None):
    """
    Update manual review fields for an image item in DynamoDB.

    Parameters:
        job_id: String
        image_id: String
        reader_name: String (optional)
        manual_read_origin: String (optional, 'Hatchery' or 'Wild')
        review_status: String (optional, 'pending'/'reviewed'/'approved')
        reviewer_id: String (optional, username of reviewer)

    Returns:
        (success: Boolean, error: String or None)
    """
    try:
        now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'

        update_parts = ['updated_at = :now']
        attr_values = {':now': {'S': now}}

        if reader_name is not None:
            update_parts.append('reader_name = :reader_name')
            attr_values[':reader_name'] = {'S': reader_name}
        if manual_read_origin is not None:
            update_parts.append('manual_read_origin = :manual_read_origin')
            attr_values[':manual_read_origin'] = {'S': manual_read_origin}
        if review_status is not None:
            update_parts.append('review_status = :review_status')
            attr_values[':review_status'] = {'S': review_status}
        if reviewer_id is not None:
            update_parts.append('reviewer_id = :reviewer_id')
            attr_values[':reviewer_id'] = {'S': reviewer_id}

        dynamodb_client.update_item(
            TableName=DYNAMODB_TABLE_NAME,
            Key={
                'job_id': _job_id_attr(job_id),
                'image_id': {'S': image_id}
            },
            UpdateExpression='SET ' + ', '.join(update_parts),
            ExpressionAttributeValues=attr_values
        )

        return True, None
    except Exception as e:
        return False, str(e)


def get_job_num_images(job_id):
    """
    Get current number of images in a job
    
    Parameters:
        job_id: String or Integer
    
    Returns:
        Integer - Current number of images (0 if job doesn't exist)
    """
    try:
        response = dynamodb_client.get_item(
            TableName=DYNAMODB_TABLE_NAME,
            Key={
                'job_id': _job_id_attr(job_id),
                'image_id': {'S': 'meta'}
            }
        )
        
        if 'Item' in response:
            return int(response['Item'].get('num_images', {}).get('N', '0'))
        return 0
    except Exception as e:
        print(f"Error getting job num_images: {str(e)}")
        return 0


def update_job_meta_num_images(job_id, num_images):
    """
    Update num_images in job meta
    
    Parameters:
        job_id: String or Integer
        num_images: Integer
    
    Returns:
        (success: Boolean, error: String or None)
    """
    try:
        now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f') + 'Z'
        
        dynamodb_client.update_item(
            TableName=DYNAMODB_TABLE_NAME,
            Key={
                'job_id': _job_id_attr(job_id),
                'image_id': {'S': 'meta'}
            },
            UpdateExpression='SET num_images = :num, updated_at = :now',
            ExpressionAttributeValues={
                ':num': {'N': str(num_images)},
                ':now': {'S': now}
            }
        )
        
        return True, None
    except Exception as e:
        return False, str(e)


def get_all_jobs(limit=100):
    """
    Get all jobs from DynamoDB
    
    Parameters:
        limit: Maximum number of jobs to return (default: 100, None for all)
    
    Returns:
        List of job metadata dictionaries
    """
    try:
        jobs = []
        
        # First try to get meta items with pagination
        last_evaluated_key = None
        while True:
            scan_kwargs = {
                'TableName': DYNAMODB_TABLE_NAME,
                'FilterExpression': 'image_id = :meta',
                'ExpressionAttributeValues': {
                    ':meta': {'S': 'meta'}
                }
            }
            
            if last_evaluated_key:
                scan_kwargs['ExclusiveStartKey'] = last_evaluated_key
            
            response = dynamodb_client.scan(**scan_kwargs)
            meta_items = response.get('Items', [])
            
            # Process meta items
            for item in meta_items:
                job = {
                    'job_id': item['job_id']['S'],
                    'user_id': item.get('user_id', {}).get('S', 'unknown'),
                    'status': item.get('status', {}).get('S', 'unknown'),
                    'created_at': item.get('created_at', {}).get('S', ''),
                    'updated_at': item.get('updated_at', {}).get('S', ''),
                    'num_images': int(item.get('num_images', {}).get('N', '0')),
                    'model_version': item.get('model_version', {}).get('S', '')
                }
                jobs.append(job)
            
            # Check if there are more pages
            last_evaluated_key = response.get('LastEvaluatedKey')
            if not last_evaluated_key:
                break
            
            # If limit is set and we've reached it, stop
            if limit and len(jobs) >= limit:
                break
        
        # Also scan all items to find jobs that might not have meta items
        # This ensures we don't miss any jobs
        print("[INFO] Scanning all items to find all unique job_ids...")
        job_ids_set = set([job['job_id'] for job in jobs])  # Start with jobs found via meta
        job_data = {}
        last_evaluated_key = None
        
        while True:
            scan_kwargs = {
                'TableName': DYNAMODB_TABLE_NAME
            }
            
            if last_evaluated_key:
                scan_kwargs['ExclusiveStartKey'] = last_evaluated_key
            
            all_response = dynamodb_client.scan(**scan_kwargs)
            
            for item in all_response.get('Items', []):
                job_id = item.get('job_id', {}).get('S', '')
                if not job_id:
                    continue
                    
                job_ids_set.add(job_id)
                
                # Store first occurrence data for each job (only if not already stored from meta)
                if job_id not in job_data:
                    job_data[job_id] = {
                        'job_id': job_id,
                        'created_at': item.get('created_at', {}).get('S', ''),
                        'updated_at': item.get('updated_at', {}).get('S', ''),
                    }
            
            # Check if there are more pages
            last_evaluated_key = all_response.get('LastEvaluatedKey')
            if not last_evaluated_key:
                break
            
            # Safety limit: if we've scanned too many items, stop
            if len(job_ids_set) > (limit or 1000):
                break
        
        # Add jobs that weren't found via meta items
        existing_job_ids = set([job['job_id'] for job in jobs])
        for job_id in job_ids_set:
            if job_id not in existing_job_ids:
                # Count images for this job
                num_images = 0
                query_last_key = None
                
                # Query with pagination to count all images
                while True:
                    query_kwargs = {
                        'TableName': DYNAMODB_TABLE_NAME,
                        'KeyConditionExpression': 'job_id = :job_id',
                        'ExpressionAttributeValues': {
                            ':job_id': {'S': job_id}
                        },
                        'Select': 'COUNT'
                    }
                    
                    if query_last_key:
                        query_kwargs['ExclusiveStartKey'] = query_last_key
                    
                    count_response = dynamodb_client.query(**query_kwargs)
                    num_images += count_response.get('Count', 0)
                    
                    query_last_key = count_response.get('LastEvaluatedKey')
                    if not query_last_key:
                        break
                
                jobs.append({
                    'job_id': job_id,
                    'user_id': 'unknown',
                    'status': 'completed',
                    'created_at': job_data[job_id].get('created_at', ''),
                    'updated_at': job_data[job_id].get('updated_at', ''),
                    'num_images': num_images,
                    'model_version': 'unknown'
                })
        
        # Sort by created_at descending (newest first)
        jobs.sort(key=lambda x: x['created_at'] or '', reverse=True)
        
        # Apply limit if specified
        if limit:
            return jobs[:limit]
        return jobs
    except Exception as e:
        print(f"Error getting all jobs: {str(e)}")
        import traceback
        traceback.print_exc()
        return []


def get_job_images(job_id, limit=1000):
    """
    Get all images for a specific job with pagination support
    
    Parameters:
        job_id: String
        limit: Maximum number of images to return (None for all)
    
    Returns:
        List of image item dictionaries
    """
    try:
        images = []
        last_evaluated_key = None
        
        # Query with pagination to get all images
        while True:
            query_kwargs = {
                'TableName': DYNAMODB_TABLE_NAME,
                'KeyConditionExpression': 'job_id = :job_id',
                'ExpressionAttributeValues': {
                    ':job_id': _job_id_attr(job_id)
                }
            }
            
            if last_evaluated_key:
                query_kwargs['ExclusiveStartKey'] = last_evaluated_key
            
            response = dynamodb_client.query(**query_kwargs)
            
            for item in response.get('Items', []):
                # Filter out meta items
                image_id = item.get('image_id', {}).get('S', '')
                if image_id == 'meta':
                    continue
                
                # Extract image data
                image = {
                    'image_id': image_id,
                    'raw_key': item.get('raw_key', {}).get('S', ''),
                    'overlay_key': item.get('overlay_key', {}).get('S', ''),
                    'pred_label': int(item.get('pred_label', {}).get('N', '0')),
                    'confidence': float(item.get('confidence', {}).get('N', '0.0')),
                    'fork_length': float(item.get('fork_length', {}).get('N', '0.0')),
                    'sex': int(item.get('sex', {}).get('N', '2')),
                    'user_id': item.get('user_id', {}).get('S', ''),
                    'review_status': item.get('review_status', {}).get('S', 'pending'),
                    'submitted_to_lab': item.get('submitted_to_lab', {}).get('BOOL', False),
                    'created_at': item.get('created_at', {}).get('S', ''),
                    'reader_name': item.get('reader_name', {}).get('S', ''),
                    'manual_read_origin': item.get('manual_read_origin', {}).get('S', ''),
                    'reviewer_id': item.get('reviewer_id', {}).get('S', '')
                }
                images.append(image)
                
                # Stop if we've reached the limit
                if limit and len(images) >= limit:
                    return images[:limit]
            
            # Check if there are more pages
            last_evaluated_key = response.get('LastEvaluatedKey')
            if not last_evaluated_key:
                break
        
        return images
    except Exception as e:
        print(f"Error getting job images: {str(e)}")
        import traceback
        traceback.print_exc()
        return []


def get_all_history_data(limit_jobs=None, limit_images_per_job=None):
    """
    Get all history data (all jobs with their images)
    
    Parameters:
        limit_jobs: Maximum number of jobs to return (None for all)
        limit_images_per_job: Maximum number of images per job (None for all)
    
    Returns:
        Dictionary with 'jobs' and 'images_by_job' keys
    """
    try:
        print(f"[INFO] Fetching history data: limit_jobs={limit_jobs}, limit_images_per_job={limit_images_per_job}")
        jobs = get_all_jobs(limit=limit_jobs)
        print(f"[INFO] Found {len(jobs)} jobs")
        
        images_by_job = {}
        
        for idx, job in enumerate(jobs):
            job_id = job['job_id']
            print(f"[INFO] Fetching images for job {idx + 1}/{len(jobs)}: {job_id}")
            images = get_job_images(job_id, limit=limit_images_per_job)
            images_by_job[job_id] = images
            print(f"[INFO] Found {len(images)} images for job {job_id}")
        
        total_images = sum(len(imgs) for imgs in images_by_job.values())
        print(f"[INFO] Total images fetched: {total_images}")
        
        return {
            'jobs': jobs,
            'images_by_job': images_by_job
        }
    except Exception as e:
        print(f"Error getting all history data: {str(e)}")
        import traceback
        traceback.print_exc()
        return {'jobs': [], 'images_by_job': {}}
