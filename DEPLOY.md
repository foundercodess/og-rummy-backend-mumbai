# Deploy OG Rummy API to AWS App Runner

Deploy the API so you can test it from a public URL (e.g. `https://xxx.us-east-1.awsapprunner.com`).

---

## Prerequisites

- AWS CLI configured (`aws configure`)
- Docker installed and running
- RDS PostgreSQL (your `DATABASE_URL` in `.env`)
- GitHub repo (for CI/CD) or manual deploy

---

## One-Time Setup

### 1. Create ECR repository (if not exists)

```bash
aws ecr create-repository --repository-name og-rummy-backend --region us-east-1
```

### 2. Create App Runner service in AWS Console

1. Go to **AWS Console** → **App Runner** → **Create service**
2. **Source:** Container registry
3. **Connect to ECR:** Select your repository `og-rummy-backend`
4. **Image tag:** `latest`
5. **Port:** `3000`
6. **Service name:** `og-rummy-api`
7. **Environment variables** – Add:
   - `DATABASE_URL` = your RDS connection string (same as `.env`)
   - `NODE_ENV` = `production`
   - `PORT` = `3000`
8. Create service

### 3. Copy App Runner URL

After creation, copy the URL (e.g. `https://xxxxx.us-east-1.awsapprunner.com`).

---

## Deploy (Manual)

```bash
# Set your App Runner service ARN (from AWS Console → App Runner → your service → ARN)
export APP_RUNNER_SERVICE_ARN=arn:aws:apprunner:us-east-1:YOUR_ACCOUNT:service/og-rummy-api/xxxxx
export AWS_REGION=us-east-1

# Deploy
chmod +x scripts/deploy-apprunner.sh
./scripts/deploy-apprunner.sh
```

---

## Deploy (GitHub Actions CI/CD)

1. Add **GitHub Secrets** (Settings → Secrets → Actions):
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION` = `us-east-1`
   - `APP_RUNNER_SERVICE_ARN` = your App Runner service ARN

2. Push to `main`:
   ```bash
   git add .
   git commit -m "Deploy"
   git push origin main
   ```

3. GitHub Actions will build, push to ECR, and trigger App Runner deployment.

---

## Test the API

After deployment, test:

```bash
# Health check
curl https://YOUR_APP_RUNNER_URL/health

# Send OTP
curl -X POST https://YOUR_APP_RUNNER_URL/api/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210"}'

# Verify OTP (use OTP from send response in dev, or from SMS in prod)
curl -X POST https://YOUR_APP_RUNNER_URL/api/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210","otp":"123456"}'
```

---

## Notes

- **Migrations** run automatically when the container starts (before the server).
- **RDS security group** must allow inbound 5432 from App Runner (or 0.0.0.0/0 for testing).
- **DATABASE_URL** must be set in App Runner environment variables.
