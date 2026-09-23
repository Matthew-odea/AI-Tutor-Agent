#!/usr/bin/env bash
#
# Three read-only production checks left open by the 2026-09-22/23 remediation.
# Each answers a question the code cannot: whether something exists in live data.
#
# Nothing here writes, and no check returns student data — only counts and
# parameter names. Safe to run against production.
#
#   ./scripts/prod_checks.sh
#
# Credentials come from the project .env (bedrock-user). This machine's *default*
# AWS profile belongs to a different organisation and has no access here, so the
# script prints which account it reached before doing anything — an AccessDenied
# below almost certainly means wrong account, not missing data.

set -uo pipefail
cd "$(dirname "$0")/.."

REGION="${REGION:-ap-southeast-2}"        # live compute and all DynamoDB data
SSM_PATH="${SSM_PATH:-/ai-tutor/prod/}"
TABLE="${TABLE:-oral_assessments}"

if [[ -f .env ]]; then
  set -a; source .env; set +a          # by reference: nothing lands in argv or history
fi

echo "== Account =="
if ! aws sts get-caller-identity --query 'Account' --output text 2>/dev/null; then
  echo "Could not authenticate. Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env." >&2
  exit 1
fi
echo "Region: ${REGION}"
echo

# ── 1 ────────────────────────────────────────────────────────────────────────
# The plaintext password fallback is gone. No stored DynamoDB password can be
# plaintext (every write path hashes), but these two env bootstraps are the one
# remaining source. If either is set with a plaintext value, that login stops
# working on deploy. Names only — never the value.
echo "== 1. Plaintext login bootstraps in SSM =="
hits=$(aws ssm get-parameters-by-path --path "${SSM_PATH}" --recursive \
         --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null \
       | tr '\t' '\n' | grep -iE 'AUTH_USERS_JSON|AUTH_LOGIN_PASSWORD' || true)
if [[ -z "$hits" ]]; then
  echo "  CLEAR — neither is set. Safe to deploy."
else
  echo "  PRESENT:"; echo "$hits" | sed 's/^/    /'
  echo "  -> That login breaks on deploy. Store a PBKDF2 hash, or use the reset flow."
fi
echo

# ── 2 ────────────────────────────────────────────────────────────────────────
# The student-facing aggregator read totalScore and ignored instructorScore,
# while the instructor view honoured it. An overridden grade therefore showed
# corrected to the instructor and uncorrected to the student. Fixed 2026-09-22 —
# this asks whether it ever fired on real data.
echo "== 2. Instructor grade overrides ever used =="
n=$(aws dynamodb scan --table-name "${TABLE}" --region "${REGION}" \
      --filter-expression "attribute_exists(instructorScore)" \
      --select COUNT --query 'Count' --output text 2>/dev/null)
if [[ -z "$n" ]]; then
  echo "  Could not read ${TABLE} in ${REGION}."
elif [[ "$n" == "0" ]]; then
  echo "  CLEAR — 0 overrides. The bug was latent; no grade was misreported."
else
  echo "  ${n} overridden question(s) exist."
  echo "  -> Those students were shown the un-overridden score. Re-check what they saw."
fi
echo

# ── 3 ────────────────────────────────────────────────────────────────────────
# The question-bank write path was deleted as dead. get_bank_questions still
# reads BANK_QUESTION# items. Deleting that read is only safe if none exist.
echo "== 3. Question-bank items still in the table =="
n=$(aws dynamodb scan --table-name "${TABLE}" --region "${REGION}" \
      --filter-expression "begins_with(SK, :b)" \
      --expression-attribute-values '{":b":{"S":"BANK_QUESTION#"}}' \
      --select COUNT --query 'Count' --output text 2>/dev/null)
if [[ -z "$n" ]]; then
  echo "  Could not read ${TABLE} in ${REGION}."
elif [[ "$n" == "0" ]]; then
  echo "  CLEAR — 0 items. Safe to delete OralAssessmentQuestionAccess.get_bank_questions."
else
  echo "  ${n} BANK_QUESTION# item(s) exist — the read is load-bearing. Keep it."
fi
