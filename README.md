# Project Structure

This document explains the current directory structure of the repository and identifies which parts are actively used by the deployed system.

## Active Directories

### `frontend`
Active frontend source directory.

Contents:
- `index.html`: main frontend entry page
- `styles.css`: frontend stylesheet
- `js/`: frontend JavaScript files
- `image/`: frontend static image assets

Usage:
- This is the frontend currently used for local testing and S3 static deployment.
- When updating the production frontend, upload the contents of this directory to the S3 bucket and invalidate CloudFront.

### `server`
Active Node.js service directory.

Contents:
- `app.js`: Node server entry point
- `routes/`: API route handlers
- `models/`: user and registration models
- `services/`: AWS and email-related services
- `middleware/`: authentication middleware
- `scripts/`: admin and utility scripts

Usage:
- This service handles login, registration, admin approval, and API proxying.
- The deployed systemd service name is `fish-node`.

### `salmon-backend`
Active Python backend directory.

Contents:
- `predict_api.py`: Flask backend entry point
- `src/`: backend modules and model code
- `scripts/`: backend maintenance scripts
- `venv/`: Python virtual environment used by the deployed backend
- `6L_0108_105614.ckpt`: model checkpoint
- `requirements.freeze.txt`: frozen dependency snapshot
- `salmon-backend.service`: systemd unit file for the backend service

Usage:
- This is the backend currently used by the deployed system.
- The deployed systemd service name is `salmon-backend`.



## Service Names

The deployed system uses these service names:

- Node.js service: `fish-node`
- Python backend service: `salmon-backend`

Useful commands:

```bash
sudo systemctl status fish-node
sudo systemctl restart fish-node

sudo systemctl status salmon-backend
sudo systemctl restart salmon-backend
```

## How to Run the Project

This project can be run in two common ways:
- by using the deployed services already configured on the EC2 server
- by starting the services locally for testing

### Run on the Server

After connecting to the EC2 instance, check whether both services are running:

```bash
sudo systemctl status salmon-backend
sudo systemctl status fish-node
```

Expected result:
- both services should show `active (running)`

If a service is not running, restart it:

```bash
sudo systemctl restart salmon-backend
sudo systemctl restart fish-node
```

After both services are running, access the system through:

```text
https://salmonsays.site/
```

For local access on the server machine or through SSH port forwarding, use:

```text
http://localhost:4000
```

Example SSH tunnel from your local machine:

```bash
ssh -L 4000:localhost:4000 ubuntu@ec2-35-163-47-188.us-west-2.compute.amazonaws.com
```

Then open:

```text
http://localhost:4000
```

### Run Locally for Development

Start the Node.js service:

```bash
cd server
npm install
node app.js
```

Start the Python backend in another terminal:

```bash
cd salmon-backend
./venv/bin/pip install -r requirements.freeze.txt
./venv/bin/python predict_api.py
```

Then open the application in a browser:

```text
http://localhost:4000
```

### Frontend Deployment

The frontend is deployed manually. After updating frontend code, upload the files from `frontend/` to the S3 bucket and invalidate CloudFront.

Example:

```bash
aws s3 sync ./frontend s3://<bucket-name> --delete
aws cloudfront create-invalidation --distribution-id <distribution-id> --paths "/*"
```

### Backend Code Updates

After updating backend code on the server, restart the corresponding services so the changes take effect:

```bash
sudo systemctl restart salmon-backend
sudo systemctl restart fish-node
```
