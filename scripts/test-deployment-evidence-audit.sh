#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-deployment-evidence.sh"

fail() {
  echo "[deployment-evidence-test][error] $*" >&2
  exit 1
}

write_blocked_manifest() {
  local file="$1"
  cat >"$file" <<'JSON'
{
  "schemaVersion": 1,
  "scope": "solswap-indexer-production-deployment-readiness",
  "serviceId": "si.soramitsu.io",
  "baseUrl": "https://si.soramitsu.io",
  "status": "blocked",
  "releaseEnabled": false,
  "blockers": [
    "production-deployment-evidence-missing",
    "live-production-smoke-failing",
    "production-routing-mismatch"
  ],
  "smokeCommand": "SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production",
  "dockerBuildCommand": "docker build -t solswap-indexer:release .",
  "readyVerificationCommands": [
    "npm run test:deployment-evidence-template",
    "npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json",
    "npm run test:deployment-evidence-audit",
    "npm run audit:deployment-evidence -- --require-ready",
    "docker build -t solswap-indexer:release .",
    "SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production"
  ],
  "requiredEvidenceFields": [
    "commit",
    "imageDigest",
    "deploymentId",
    "baseUrl",
    "smokeCommand",
    "smokePassedAt",
    "operator"
  ],
  "deploymentEvidence": []
}
JSON
}

write_ready_manifest() {
  local file="$1"
  cat >"$file" <<'JSON'
{
  "schemaVersion": 1,
  "scope": "solswap-indexer-production-deployment-readiness",
  "serviceId": "si.soramitsu.io",
  "baseUrl": "https://si.soramitsu.io",
  "status": "ready",
  "releaseEnabled": true,
  "blockers": [],
  "smokeCommand": "SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production",
  "dockerBuildCommand": "docker build -t solswap-indexer:release .",
  "readyVerificationCommands": [
    "npm run test:deployment-evidence-template",
    "npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json",
    "npm run test:deployment-evidence-audit",
    "npm run audit:deployment-evidence -- --require-ready",
    "docker build -t solswap-indexer:release .",
    "SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production"
  ],
  "requiredEvidenceFields": [
    "commit",
    "imageDigest",
    "deploymentId",
    "baseUrl",
    "smokeCommand",
    "smokePassedAt",
    "operator"
  ],
  "deploymentEvidence": [
    {
      "commit": "1111111111111111111111111111111111111111",
      "imageDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "deploymentId": "si-release-20260626",
      "baseUrl": "https://si.soramitsu.io",
      "smokeCommand": "SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production",
      "smokePassedAt": "2026-06-26T00:00:00Z",
      "operator": "release"
    }
  ]
}
JSON
}

run_audit() {
  local manifest="$1"
  shift
  bash "$AUDIT_SCRIPT" --evidence "$manifest" "$@"
}

expect_failure() {
  local name="$1"
  local expected="$2"
  shift 2
  local output

  set +e
  output="$("$@" 2>&1)"
  local status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    echo "$output" >&2
    fail "$name unexpectedly passed"
  fi

  if [[ "$output" != *"$expected"* ]]; then
    echo "$output" >&2
    fail "$name did not report expected text: $expected"
  fi
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

blocked="$tmp_dir/blocked.json"
ready="$tmp_dir/ready.json"
write_blocked_manifest "$blocked"
write_ready_manifest "$ready"

run_audit "$blocked" >/dev/null
run_audit "$ready" --require-ready >/dev/null

expect_failure "missing deployment evidence manifest" "production deployment evidence manifest missing" run_audit "$tmp_dir/missing.json"

bad_json="$tmp_dir/bad-json.json"
printf '{' >"$bad_json"
expect_failure "invalid deployment evidence JSON" "must be valid JSON" run_audit "$bad_json"

bad_schema="$tmp_dir/bad-schema.json"
cp "$blocked" "$bad_schema"
perl -0pi -e 's/"schemaVersion": 1/"schemaVersion": 2/' "$bad_schema"
expect_failure "bad schema" "schemaVersion must be 1" run_audit "$bad_schema"

release_enabled_blocked="$tmp_dir/release-enabled-blocked.json"
cp "$blocked" "$release_enabled_blocked"
perl -0pi -e 's/"releaseEnabled": false/"releaseEnabled": true/' "$release_enabled_blocked"
expect_failure "release enabled while blocked" "releaseEnabled must remain false while deployment evidence is blocked" run_audit "$release_enabled_blocked"

missing_blocker="$tmp_dir/missing-blocker.json"
cp "$blocked" "$missing_blocker"
perl -0pi -e 's/,\n    "production-routing-mismatch"//' "$missing_blocker"
expect_failure "blocked evidence missing routing blocker" "blocked deployment evidence missing blocker production-routing-mismatch" run_audit "$missing_blocker"

missing_ready_command="$tmp_dir/missing-ready-command.json"
cp "$blocked" "$missing_ready_command"
perl -0pi -e 's/npm run audit:deployment-evidence -- --require-ready/npm run audit:deployment-evidence/' "$missing_ready_command"
expect_failure "missing require-ready command" "readyVerificationCommands missing npm run audit:deployment-evidence -- --require-ready" run_audit "$missing_ready_command"

missing_template_test_command="$tmp_dir/missing-template-test-command.json"
cp "$blocked" "$missing_template_test_command"
perl -0pi -e 's/"npm run test:deployment-evidence-template",\n//' "$missing_template_test_command"
expect_failure "missing template self-test command" "readyVerificationCommands missing npm run test:deployment-evidence-template" run_audit "$missing_template_test_command"

missing_template_generator_command="$tmp_dir/missing-template-generator-command.json"
cp "$blocked" "$missing_template_generator_command"
perl -0pi -e 's/"npm run generate:deployment-evidence-template -- --output build\/reports\/production-deployment-evidence-template.json",\n//' "$missing_template_generator_command"
expect_failure "missing template generator command" "readyVerificationCommands missing npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json" run_audit "$missing_template_generator_command"

missing_field="$tmp_dir/missing-field.json"
cp "$blocked" "$missing_field"
perl -0pi -e 's/"imageDigest",\n//' "$missing_field"
expect_failure "missing image digest field" "requiredEvidenceFields missing imageDigest" run_audit "$missing_field"

unsupported_required_field="$tmp_dir/unsupported-required-field.json"
cp "$blocked" "$unsupported_required_field"
node - "$unsupported_required_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields.push('region');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported required evidence field" "unsupported deployment evidence field in manifest: region" run_audit "$unsupported_required_field"

ready_no_evidence="$tmp_dir/ready-no-evidence.json"
cp "$ready" "$ready_no_evidence"
perl -0pi -e 's/"deploymentEvidence": \[[\s\S]*?\n  \]/"deploymentEvidence": []/' "$ready_no_evidence"
expect_failure "ready evidence without live smoke" "ready deployment evidence requires at least one successful live production smoke record" run_audit "$ready_no_evidence" --require-ready

ready_with_blocker="$tmp_dir/ready-with-blocker.json"
cp "$ready" "$ready_with_blocker"
perl -0pi -e 's/"blockers": \[\]/"blockers": ["production-routing-mismatch"]/' "$ready_with_blocker"
expect_failure "ready evidence carries blockers" "blockers must be empty when deployment evidence is ready" run_audit "$ready_with_blocker" --require-ready

bad_commit="$tmp_dir/bad-commit.json"
cp "$ready" "$bad_commit"
perl -0pi -e 's/1111111111111111111111111111111111111111/1111/' "$bad_commit"
expect_failure "bad commit evidence" "commit must be a 40-character git commit" run_audit "$bad_commit" --require-ready

bad_digest="$tmp_dir/bad-digest.json"
cp "$ready" "$bad_digest"
perl -0pi -e 's/sha256:2222222222222222222222222222222222222222222222222222222222222222/2222/' "$bad_digest"
expect_failure "bad image digest evidence" "imageDigest must be a sha256 image digest" run_audit "$bad_digest" --require-ready

duplicate_deployment="$tmp_dir/duplicate-deployment.json"
cp "$ready" "$duplicate_deployment"
node - "$duplicate_deployment" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence.push({
  ...manifest.deploymentEvidence[0],
  commit: '3333333333333333333333333333333333333333',
  imageDigest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  smokePassedAt: '2026-06-26T00:05:00Z',
});
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "duplicate deployment id evidence" "duplicate deployment evidence id: si-release-20260626" run_audit "$duplicate_deployment" --require-ready

wrong_base="$tmp_dir/wrong-base.json"
cp "$ready" "$wrong_base"
perl -0pi -e 's#https://si.soramitsu.io#https://wrong.example#g' "$wrong_base"
expect_failure "wrong production base URL evidence" "baseUrl must be https://si.soramitsu.io" run_audit "$wrong_base" --require-ready

unsupported_top_level="$tmp_dir/unsupported-top-level.json"
cp "$ready" "$unsupported_top_level"
node - "$unsupported_top_level" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.region = 'eu-central-1';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported top-level deployment evidence field" "deployment evidence.region is not supported in public deployment evidence" run_audit "$unsupported_top_level" --require-ready

unsupported_record_field="$tmp_dir/unsupported-record-field.json"
cp "$ready" "$unsupported_record_field"
node - "$unsupported_record_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].region = 'eu-central-1';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported deployment evidence record field" "deploymentEvidence[0].region is not supported in public deployment evidence" run_audit "$unsupported_record_field" --require-ready

wrong_smoke="$tmp_dir/wrong-smoke.json"
cp "$ready" "$wrong_smoke"
perl -0pi -e 's/SOLSWAP_INDEXER_BASE_URL=https:\/\/si\.soramitsu\.io npm run smoke:production/npm run smoke:production/g' "$wrong_smoke"
expect_failure "wrong production smoke command evidence" "smokeCommand must be SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production" run_audit "$wrong_smoke" --require-ready

bad_timestamp="$tmp_dir/bad-timestamp.json"
cp "$ready" "$bad_timestamp"
perl -0pi -e 's/2026-06-26T00:00:00Z/2026-06-26/' "$bad_timestamp"
expect_failure "bad smoke timestamp evidence" "smokePassedAt must be an ISO-8601 UTC second timestamp" run_audit "$bad_timestamp" --require-ready

secret_top_level="$tmp_dir/secret-top-level.json"
cp "$ready" "$secret_top_level"
perl -0pi -e 's/"deploymentEvidence": \[/"privateKey": "do-not-commit",\n  "deploymentEvidence": [/' "$secret_top_level"
expect_failure "secret-like deployment evidence key" "must not be included in public deployment evidence" run_audit "$secret_top_level" --require-ready

secret_nested="$tmp_dir/secret-nested.json"
cp "$ready" "$secret_nested"
perl -0pi -e 's/"operator": "release"/"operator": "release",\n      "authorization": "Bearer do-not-commit"/' "$secret_nested"
expect_failure "nested secret-like deployment evidence key" "must not be included in public deployment evidence" run_audit "$secret_nested" --require-ready

echo "[deployment-evidence-test] all assertions passed"
