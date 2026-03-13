# Project Structure

This document explains the current directory structure of the `Fish-App` repository and identifies which parts are actively used by the deployed system.

## Active Directories

### `Fish-App/frontend`
Active frontend source directory.

Contents:
- `index.html`: main frontend entry page
- `styles.css`: frontend stylesheet
- `js/`: frontend JavaScript files
- `image/`: frontend static image assets

Usage:
- This is the frontend currently used for local testing and S3 static deployment.
- When updating the production frontend, upload the contents of this directory to the S3 bucket and invalidate CloudFront.

### `Fish-App/server`
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

### `Fish-App/salmon-backend`
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

