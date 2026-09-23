"""
Grant the admin role to an existing user, directly in DynamoDB.

`PUT /api/auth/users/{email}/roles` is admin-only, so the first admin cannot be
created through the API. This script is that bootstrap: run it once, then use the
API for everyone else.

The user must already exist (sign up first) — this only adds a role, it never
creates an account or touches a password.

Examples:
  python scripts/promote_to_admin.py --email someone@example.com
  python scripts/promote_to_admin.py --email someone@example.com --region ap-southeast-2
"""

from __future__ import annotations

import argparse
import os
import sys

import boto3
from botocore.exceptions import ClientError


def main() -> int:
    parser = argparse.ArgumentParser(description="Add the admin role to an existing user")
    parser.add_argument("--email", required=True, help="Email of the user to promote")
    parser.add_argument(
        "--table",
        default=os.getenv("DYNAMODB_AUTH_USERS_TABLE", "auth_users"),
        help="Auth users table name",
    )
    parser.add_argument(
        "--region",
        default=os.getenv("AWS_DEFAULT_REGION", "ap-southeast-2"),
        help="AWS region holding the table",
    )
    args = parser.parse_args()

    email = args.email.strip().lower()
    table = boto3.resource("dynamodb", region_name=args.region).Table(args.table)

    item = table.get_item(Key={"email": email}).get("Item")
    if not item:
        print(f"No user {email} in {args.table} ({args.region}). They must sign up first.")
        return 1

    roles = [str(role) for role in item.get("roles", []) if str(role).strip()]
    if "admin" in roles:
        print(f"{email} is already an admin (roles: {roles}).")
        return 0

    new_roles = roles + ["admin"]
    try:
        table.update_item(
            Key={"email": email},
            UpdateExpression="SET #r = :roles",
            ExpressionAttributeNames={"#r": "roles"},
            ExpressionAttributeValues={":roles": new_roles},
            ConditionExpression="attribute_exists(email)",
        )
    except ClientError as error:
        print(f"Failed to update roles: {error}")
        return 1

    print(f"{email}: {roles} -> {new_roles}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
