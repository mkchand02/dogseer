#!/bin/bash
set -e

echo "--- Loading environment variables from .env file ---"
# Check if .env file exists
if [ ! -f .env ]; then
    echo "ERROR: .env file not found. Please create it by copying .env.example and filling it out."
    exit 1
fi
export $(grep -v '^#' .env | xargs)

# Check if GEMINI_API_KEY is set
if [ -z "$GEMINI_API_KEY" ]; then
    echo "ERROR: GEMINI_API_KEY is not set in your .env file."
    exit 1
fi

echo "--- Setting GCP project ---"
gcloud config set project gcloud-hackathon-1ioct4ba0xy0v

echo "--- Building Docker image with Cloud Build ---"
gcloud builds submit --tag gcr.io/gcloud-hackathon-1ioct4ba0xy0v/dogseer-agent ./agent

echo "--- Deploying to Cloud Run ---"
gcloud run deploy dogseer-agent 
  --image gcr.io/gcloud-hackathon-1ioct4ba0xy0v/dogseer-agent 
  --region us-central1 
  --platform managed 
  --allow-unauthenticated 
  --set-env-vars="GEMINI_API_KEY=$GEMINI_API_KEY" 
  --quiet

echo "--- Deployment complete! ---"
