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

# No .env means the CLI falls back to this machine's default profile, which is a
# different organisation's account. Every check then reads an empty path and
# looks clear. Refuse rather than guess.
if [[ ! -f .env ]]; then
  echo "No .env in $(pwd). Without it these checks hit the wrong AWS account and report a false clear." >&2
  exit 1
fi
set -a; source .env; set +a            # by reference: nothing lands in argv or history

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
names=$(aws ssm get-parameters-by-path --path "${SSM_PATH}" --recursive \
          --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null \
        | tr '\t' '\n')
hits=$(echo "$names" | grep -iE 'AUTH_USERS_JSON|AUTH_LOGIN_PASSWORD' || true)
# AUTH_JWT_SECRET is in load-ssm-env.sh's required set, so the real path always
# has it. Without it this is the wrong account or no access, not a clear result.
if ! echo "$names" | grep -q 'AUTH_JWT_SECRET'; then
  echo "  UNKNOWN — ${SSM_PATH} is empty or unreadable in this account. Wrong credentials?"
elif [[ -z "$hits" ]]; then
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
echo

# ── 4 ────────────────────────────────────────────────────────────────────────
# Until 2026-09-23 the client chose its own S3 key, and a stored answer or
# proctoring chunk URL was never checked against the row's own student. Stored
# URLs are presigned for download by key alone, so a row pointing into another
# student's folder handed its viewer that student's recording. The server now
# builds keys and refuses foreign ones; this asks whether any got in before.
# Keys and URLs are compared locally and only counts are printed.
#
# CLEAR here does not rule out an overwrite: the old upload route would presign
# a PUT to any key, so a file under the right folder may still have been
# replaced. Only S3 versioning or CloudTrail data events can answer that.
echo "== 4. Stored media pointing outside its own student's folder =="
aws dynamodb scan --table-name "${TABLE}" --region "${REGION}" \
    --filter-expression "begins_with(SK, :a) OR begins_with(SK, :c)" \
    --expression-attribute-values '{":a":{"S":"ANSWER#"},":c":{"S":"PROCTORING#CHUNK#"}}' \
    --projection-expression "PK, audioUrl, videoUrl, chunkUrl" \
    --output json 2>/dev/null \
  | python3 -c '
import json, re, sys
from urllib.parse import unquote, urlparse

raw = sys.stdin.read()
if not raw.strip():
    sys.exit(print("  Could not read the table."))
owner = re.compile(r"^STUDENT#(.+)#ASSESSMENT#(.+)$")
counts = {"own": 0, "foreign_audio": 0, "foreign_proctoring": 0, "unrecognised": 0}
items = json.loads(raw).get("Items", [])
for item in items:
    match = owner.match(item.get("PK", {}).get("S", ""))
    for attr in ("audioUrl", "videoUrl", "chunkUrl"):
        url = item.get(attr, {}).get("S", "")
        if not url:
            continue
        parts = [unquote(p) for p in urlparse(url).path.lstrip("/").split("/")]
        if not match or ".." in parts:
            counts["unrecognised"] += 1
        elif parts[0] in ("audio", "video") and len(parts) >= 3:  # video/ is the pre-2026-09 answer layout
            counts["own" if parts[1] == match[1] else "foreign_audio"] += 1
        elif parts[0] == "proctoring" and len(parts) >= 4:
            counts["own" if parts[1:3] == [match[2], match[1]] else "foreign_proctoring"] += 1
        else:
            counts["unrecognised"] += 1
fa, fp, unknown = counts["foreign_audio"], counts["foreign_proctoring"], counts["unrecognised"]
foreign = fa + fp
print(f"  Checked {sum(counts.values())} stored media URLs across {len(items)} answer and chunk rows.")
if foreign:
    print(f"  FOREIGN — {foreign} point outside their own student'"'"'s folder "
          f"({fa} answer, {fp} proctoring).")
    print("  -> Whoever opened those rows was shown someone else'"'"'s recording. Find them before deciding who to tell.")
elif counts["own"]:
    print("  CLEAR — every recognised URL sits under its own student'"'"'s folder.")
if unknown:
    print(f"  UNRECOGNISED — {unknown} use a key layout this check does not know. Look at one before trusting CLEAR.")
'
