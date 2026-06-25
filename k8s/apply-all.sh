#!/bin/bash
# Apply all Kubernetes manifests
# Replace <ECR_URI> in deployment.yaml with your ECR URI first!
# Example: 123456789.dkr.ecr.us-east-1.amazonaws.com

set -e
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/kafka/
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/hpa.yaml
kubectl apply -f k8s/pdb.yaml
echo "Done. Run: kubectl get ingress,svc,pods -n og-rummy"
