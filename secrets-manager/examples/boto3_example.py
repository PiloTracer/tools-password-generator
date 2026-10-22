#!/usr/bin/env python3
"""Minimal boto3 client for the AWS-compatible Secrets Manager.

Install and run in your application:

    pip install -r requirements.txt
    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
      SM_ENDPOINT=http://127.0.0.1:18001 \
      python3 boto3_example.py

Inside the Compose network use SM_ENDPOINT=http://secrets-manager:8080.
The script prints metadata only, never secret values.
"""
import json
import os
import sys

import boto3

endpoint = os.environ.get("SM_ENDPOINT", "http://127.0.0.1:18001")
region = os.environ.get("AWS_REGION", "us-east-1")
environment = os.environ.get("APP_ENV", "dev")
secret_id = os.environ.get(
    "SM_POLICY_SECRET_ID", f"password-generator/{environment}/app-config"
)

if not os.environ.get("AWS_ACCESS_KEY_ID") or not os.environ.get(
    "AWS_SECRET_ACCESS_KEY"
):
    print(
        "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or source .env.dev).",
        file=sys.stderr,
    )
    sys.exit(2)

client = boto3.client(
    "secretsmanager",
    endpoint_url=endpoint,
    region_name=region,
)

try:
    listed = client.list_secrets()
    print(f"ListSecrets: {len(listed.get('SecretList', []))} secret(s)")

    result = client.get_secret_value(SecretId=secret_id)
    policy = json.loads(result["SecretString"])
    print(f"GetSecretValue: {secret_id}")
    print(f"  policy environment: {policy['environment']}")
    print(f"  policy version:     {policy['schemaVersion']}")
    print("boto3 client OK")
except Exception as error:  # noqa: BLE001 - example client
    code = getattr(error, "response", {}).get("Error", {}).get("Code", "Error")
    print(f"boto3 request failed [{code}]: {error}", file=sys.stderr)
    sys.exit(1)
