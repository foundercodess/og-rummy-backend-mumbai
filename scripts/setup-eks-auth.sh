#!/bin/bash
# Add your IAM user to EKS aws-auth so GitHub Actions can deploy
# Run this once from your computer (with AWS admin access)
#
# Usage:
#   ./scripts/setup-eks-auth.sh
#
# Or with eksctl:
#   eksctl create iamidentitymapping --cluster og-rummy-cluster --region YOUR_REGION \
#     --arn $(aws sts get-caller-identity --query Arn --output text) \
#     --username github-actions --group system:masters

set -e

CLUSTER_NAME="${EKS_CLUSTER_NAME:-og-rummy-cluster}"
REGION="${AWS_REGION:-us-east-1}"

echo "Adding IAM user to EKS cluster: $CLUSTER_NAME (region: $REGION)"
echo ""

# Get the IAM user ARN from GitHub secrets (the one in AWS_ACCESS_KEY_ID)
# You must run this with the SAME IAM user that you put in GitHub Secrets
ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)

if [ -z "$ARN" ]; then
  echo "Error: Could not get IAM identity. Run 'aws configure' first."
  exit 1
fi

echo "Your IAM identity: $ARN"
echo ""

if command -v eksctl &> /dev/null; then
  echo "Using eksctl to add IAM user..."
  eksctl create iamidentitymapping \
    --cluster "$CLUSTER_NAME" \
    --region "$REGION" \
    --arn "$ARN" \
    --username github-actions \
    --group system:masters
  echo "Done."
else
  echo "eksctl not found. Run manually:"
  echo ""
  echo "  aws eks update-kubeconfig --region $REGION --name $CLUSTER_NAME"
  echo "  kubectl edit configmap aws-auth -n kube-system"
  echo ""
  echo "Add this under data.mapUsers (or create mapUsers):"
  echo ""
  echo "  - userarn: $ARN"
  echo "    username: github-actions"
  echo "    groups:"
  echo "      - system:masters"
  echo ""
  exit 1
fi
