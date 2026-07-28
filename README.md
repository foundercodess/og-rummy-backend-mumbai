# OG Rummy Backend

A simple Node.js API with Docker and Kafka. You can run everything on your computer or deploy to a server.

---

## What You Need

- Node.js (v18 or above)
- Docker and Docker Compose (already installed)

---

## Run Without Docker (On Your Computer)

1. Go to the project folder:
   ```
   cd og_rummy_backend
   ```

2. Install packages:
   ```
   npm install
   ```

3. Start the server:
   ```
   npm start
   ```

   For OTP login, set these environment variables in your `.env`:
   ```
   OTP_PROVIDER_URL=https://indopay.cloud/otp/newsend_otp.php
   OTP_MERCHANT_KEY=your-indopay-merchant-key
   OTP_DIGITS=4
   OTP_EXPIRY_MINUTES=10
   ```

4. Open your browser and go to: http://localhost:3000

---

## Run With Docker (API + Kafka)

This runs the API and Kafka together. Good for testing.

1. Go to the project folder:
   ```
   cd og_rummy_backend
   ```

2. Run everything:
   ```
   docker compose up --build
   ```

3. The API will be at: http://localhost:3000
   - Health check: http://localhost:3000/health

4. To stop: Press `Ctrl + C`

---

## API Endpoints

| Route       | What it does                    |
|-------------|----------------------------------|
| GET /       | Welcome message                 |
| GET /health | Check if the API is running     |

---

## What Each File Does

| File                     | Purpose                                      |
|--------------------------|----------------------------------------------|
| `server.js`              | Main API code                                |
| `Dockerfile`             | Tells Docker how to build the API image      |
| `docker-compose.yml`     | Runs API and Kafka together                  |
| `.env.example`           | Copy this to `.env` and add your settings    |
| `k8s/deployment.yaml`    | Kubernetes API deployment (2 replicas)       |
| `k8s/service.yaml`       | Load balancer for the API                    |
| `k8s/kafka/`             | Kafka + Zookeeper for the cluster            |
| `.github/workflows/`     | CI/CD – auto deploy on push to main          |
| `scripts/deploy-apprunner.sh` | Build, push to ECR, trigger App Runner deploy |
| `scripts/setup-eks-auth.sh` | Add IAM user to EKS cluster access              |

---

## Deploy to AWS App Runner (API only – no EC2 quota needed)

Use this when EKS is blocked by EC2 quotas. Deploys the API only (Kafka runs locally with Docker Compose for dev).

### One-Time Setup

1. **Create ECR repository** (if not exists):
   ```bash
   aws ecr create-repository --repository-name og-rummy-backend --region us-east-1
   ```

2. **Build and push image:**
   ```bash
   chmod +x scripts/deploy-apprunner.sh
   ./scripts/deploy-apprunner.sh
   ```

3. **Create App Runner service** in AWS Console:
   - Go to **App Runner** → **Create service**
   - **Source:** Container registry
   - **Image URI:** `YOUR_ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/og-rummy-backend:latest`
   - **Port:** 3000
   - **Service name:** og-rummy-api
   - **Environment variables:** Add `DATABASE_URL`, `NODE_ENV=production`, `PORT=3000`
   - Create service
   
   See **DEPLOY.md** for full step-by-step guide.

4. **Copy the App Runner URL** (e.g. `https://xxx.eu-north-1.awsapprunner.com`) and use it in your Flutter app.

### CI/CD (GitHub Actions)

1. Add GitHub Secret: `APP_RUNNER_SERVICE_ARN` – get it from App Runner → your service → ARN
2. Push to `main` – workflow builds, pushes to ECR, and triggers App Runner deployment

### Manual deploy

```bash
export APP_RUNNER_SERVICE_ARN=arn:aws:apprunner:eu-north-1:515105386762:service/og-rummy-api/xxx
./scripts/deploy-apprunner.sh
```

---

## Deploy to AWS EKS (Kubernetes)

> **Note:** The EKS workflow is disabled (manual trigger only) until EC2 quota is approved. Use App Runner above for now.

After you create your EKS cluster and ECR repo in AWS, you can deploy automatically with CI/CD.

### One-Time Setup

1. **Create GitHub repo** and push this code.
2. **Add GitHub Secrets** (Settings → Secrets → Actions):
   - `AWS_ACCESS_KEY_ID` – Your AWS access key
   - `AWS_SECRET_ACCESS_KEY` – Your AWS secret key
   - `AWS_REGION` – e.g. `us-east-1`
   - `EKS_CLUSTER_NAME` – e.g. `og-rummy-cluster`

3. **IAM**: Your user needs `AmazonEKSClusterPolicy`, `AmazonEC2ContainerRegistryFullAccess`, and EKS cluster access. EKS node role needs `AmazonEC2ContainerRegistryReadOnly` to pull images.

4. **EKS access for CI/CD** – Run once (lets GitHub Actions use your cluster):
   ```bash
   aws configure   # use same IAM user as in GitHub Secrets
   brew install eksctl   # or: https://eksctl.io/installation/
   chmod +x scripts/setup-eks-auth.sh
   ./scripts/setup-eks-auth.sh
   ```
   Or add your IAM user to aws-auth manually; see `scripts/setup-eks-auth.sh`.

5. **First deploy (manual)** – Run once from your computer:
   ```bash
   aws eks update-kubeconfig --region YOUR_REGION --name og-rummy-cluster
   # Replace <ECR_URI> in k8s/deployment.yaml with your ECR URI
   chmod +x k8s/apply-all.sh
   ./k8s/apply-all.sh
   ```

### After Setup – Your Workflow

1. Write code locally
2. Test: `npm start` or `docker compose up`
3. Push to `main`: `git push origin main`
4. GitHub Actions builds and deploys to EKS
5. Get API URL: `kubectl get svc -n og-rummy` and use the LoadBalancer EXTERNAL-IP

### Manual Deploy (Without CI/CD)

1. Build and push to ECR
2. Run `./k8s/apply-all.sh` (after replacing `<ECR_URI>` in `k8s/deployment.yaml`)

---

## Deploy to EC2 (Automatic Redeploy on Push)

On every push to `main`, GitHub Actions deploys to your ALB game nodes **one at a time** (rolling), so at least one target stays up.

### One-Time EC2 Setup

1. Launch EC2 instance(s) in the same region/VPC as RDS (same key pair / `ec2-user` on all nodes).
2. Install Docker and Git on each instance.
3. Ensure the deployment user can run Docker without `sudo`.
4. Open inbound port `80` on the EC2 security group (from ALB SG preferred).
5. Allow the EC2 security group to reach RDS (`5432`) and Redis (`6379`/TLS).

### GitHub Secrets Required

Add these repository secrets before using the workflow:

- `EC2_HOST_1` - Public IP/DNS of node A (e.g. `13.233.105.184`)
- `EC2_HOST_2` - Public IP/DNS of node B (e.g. `15.206.67.107`) — required for dual deploy
- `EC2_USER` - SSH user, for example `ec2-user` (same on both)
- `EC2_SSH_PRIVATE_KEY` - Private SSH key contents (same key pair on both)
- `DATABASE_URL` - Production PostgreSQL connection string
- `JWT_SECRET` - Production JWT secret (must match on all nodes)
- `AWS_REGION` - Example: `ap-south-1`
- `AWS_S3_BUCKET` - S3 bucket name used by the app
- `AWS_S3_BASE_URL` - Public base URL for S3 assets
- `REDIS_URL` - Shared ElastiCache URL (required for multi-EC2)

Backwards compatible: if `EC2_HOST_1` is unset, the workflow falls back to legacy `EC2_HOST`. If `EC2_HOST_2` is unset, node 2 is skipped.

Optional secrets:

- `KAFKA_BROKERS` - Defaults to `localhost:9092`
- `JWT_EXPIRES_IN` - Defaults to `7d`
- `PORT` - Defaults to `3000`

### Workflow

The workflow file [deploy-ec2.yml](.github/workflows/deploy-ec2.yml) will, for each host:

1. Copy the repository contents to EC2.
2. Rebuild the Docker image on the server.
3. Regenerate the `.env` file from GitHub secrets.
4. Restart the `og-rummy-api` container.
5. Fail that node’s deploy if `http://localhost/health` is not healthy.

Deploy order: **node 1 → node 2** (`max-parallel: 1`).

### Triggering Deploys

1. Push code to `main`, or
2. Run the workflow manually from GitHub Actions using `workflow_dispatch`

### Confirm both nodes updated

```bash
for H in <EC2_HOST_1> <EC2_HOST_2>; do
  echo "===== $H ====="
  ssh -i ~/.ssh/og-rummy-mumbai.pem ec2-user@$H 'curl -s http://127.0.0.1/health'
  echo
done
```

Both should show the same app message / healthy Redis+DB. ALB target group should show both **Healthy**.

### Phase 1 (ALB + Multi-EC2)

- Runbook: `PHASE1_ALB_SCALING_RUNBOOK.md`
- Node preflight: `npm run phase1:preflight`

---

## Need Help?

- Make sure Docker is running
- Check that port 3000 is not used by another app
- Look at the logs: `docker compose logs -f`
