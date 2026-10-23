cd /path/to/tools-password-generator

# 1. Get the new commit
git pull --ff-only

# 2. Sanity check environment (still 33 keys; no new variables)
./bin/start.sh check-env

# 3. Recommended: full encrypted-volume backup before replacing containers
./bin/start.sh backup prd

# 4. Rebuild the images and recreate the stack
./bin/start.sh up prd
# If you want a guaranteed clean build instead (slower):
# ./bin/start.sh rebuild prd

# 5. Wait for internal + public health
./bin/start.sh health prd --strict

# 6. Verify the new credential feature and the AWS protocol
./bin/start.sh credentials prd list
./bin/start.sh secrets prd test
# Optional deeper check (now also tests ListClientCredentials):
./bin/start.sh secrets prd verify



- public edge checks:
curl -fsS https://secrets.agiolab.com/healthz
curl -fsS https://agiolab.com/api/health
curl -fsSI https://password.agiolab.com | head -1


- create production client:
./bin/start.sh credentials prd create acme \
  --description "ACME production integration" \
  --prefixes client/acme/
