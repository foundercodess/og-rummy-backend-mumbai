#!/bin/bash
# Deploy API to AWS App Runner
# Usage: ./scripts/deploy-apprunner.sh
#
# Prerequisites:
# - AWS CLI configured (aws configure)
# - Docker running
# - App Runner service created once in AWS Console (see README)
#
# Set these or export before running:
#   AWS_REGION (default: eu-central-1 - App Runner not in eu-north-1)
#   ECR_REPOSITORY (default: og-rummy-backend)
#   APP_RUNNER_SERVICE_ARN (required for start-deployment)

set -e

# Use us-east-1 if RDS is there; App Runner available in us-east-1, eu-central-1, eu-west-1
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPOSITORY="${ECR_REPOSITORY:-og-rummy-backend}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

echo "Building and pushing to ECR..."
echo "  Region: $AWS_REGION"
echo "  ECR: $ECR_URI"
echo ""

# Login to ECR
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Build for linux/amd64 (App Runner runs on x86_64; Mac M1/M2 builds arm64 by default)
# Use --no-cache to ensure latest code is built (avoids stale cached layers)
docker build --no-cache --platform linux/amd64 -t "$ECR_REPOSITORY:latest" .
docker tag "$ECR_REPOSITORY:latest" "$ECR_URI:latest"
docker push "$ECR_URI:latest"

echo ""
echo "Image pushed successfully."
echo ""

# Trigger App Runner deployment if ARN is set
if [ -n "$APP_RUNNER_SERVICE_ARN" ]; then
  echo "Starting App Runner deployment..."
  aws apprunner start-deployment --service-arn "$APP_RUNNER_SERVICE_ARN" --region "$AWS_REGION"
  echo "Deployment started. Check AWS Console for status."
else
  echo "To trigger App Runner deployment, set APP_RUNNER_SERVICE_ARN and run:"
  echo "  aws apprunner start-deployment --service-arn <YOUR_SERVICE_ARN> --region $AWS_REGION"
  echo ""
  echo "Or create/update the App Runner service in AWS Console."
fi
