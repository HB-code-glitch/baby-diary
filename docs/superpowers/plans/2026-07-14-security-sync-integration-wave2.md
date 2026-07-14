# Security and Sync Integration Wave 2

## Objective

Connect the committed Firestore capability/payload primitives to the production sync
engine without turning stricter cloud validation into local data loss. This plan starts
only after Baby Durability Wave 4 is committed and independently approved.

## Confirmed compatibility facts

- The exact `v0.3.8` `DiaryEvent` has neither `mutationId` nor `sync`.
- Its event document ID is `${id}_${rev}` and its create/join flows predate atomic user
  identity and join-proof writes.
- The current emulator "legacy" fixture is not an exact v0.3.8 fixture if it merely
  deletes `mutationId` while retaining `sync`.
- `validateDiaryEvent()` is also used by `EventLog.loadAll()`. Making it cloud-strict
  can leave parseable historical JSONL bytes on disk but silently remove them from the
  UI, export, and reconciliation. That is user-visible data loss even if bytes remain.

## Required gates

### 0. Preserve the released Firebase persistence namespace

- v0.3.8 initialized every Firebase configuration with the fixed app name
  `baby-diary`; its Auth key is `firebase:authUser:<apiKey>:baby-diary` and its
  Firestore persistence namespace is the same fixed name. A per-config digest alone
  makes an upgraded, still-valid session invisible and is therefore a data/identity
  regression.
- The first pre-existing canonical profile that upgrades must durably claim the fixed
  legacy namespace in a main-process-owned, atomic registry. This is not restricted to
  the default Firebase configuration because released custom configurations used the
  same fixed name.
- A claimed profile/config continues to receive `baby-diary` across restart and
  A -> B -> A configuration changes. Other/new profiles receive collision-resistant
  digest names. Cleanup or delayed Firebase teardown may never delete/reassign the
  active legacy claim.
- Registry corruption, concurrent windows/processes, interrupted replace, symlink or
  path substitution, and response loss fail closed without deleting IndexedDB/Auth
  state. Recovery must retain enough evidence to retry the same ownership decision.
- Missing settings must not classify a released profile as fresh when the active
  Chromium IndexedDB LevelDB contains checksum-valid evidence for the exact released
  Auth namespace. Inspect only files reachable from the stable CURRENT/MANIFEST view;
  cache files, orphan tables, or raw substring matches are not ownership evidence.
- Damaged settings are recovered from an independently verified settings/journal pair
  before the registry is published, including the Windows multi-start confirmation
  protocol. While recovery is incomplete or fails, no fresh registry may be created.
- The unreleased 16-hex FNV namespace is selected only when active on-disk evidence for
  it exists and no released `baby-diary` evidence exists. Released evidence always wins,
  and renderer input alone can never authorize a legacy/FNV namespace.
- Exact packaged upgrade evidence must prove the same uid/email/family without a new
  sign-up or family-clear fallback before hardened rules are eligible for deployment.

### 1. Separate durable-read compatibility from new/cloud writes

- Add exact v0.3.8 fixtures taken from the tagged types and production creation paths.
- A parseable historical record that was accepted by a released app must remain
  discoverable, visible, exportable, and backed up after upgrade.
- New renderer append and cloud upload keep the strict nine-type schema and size bounds.
- Do not silently skip a parseable legacy record because it has an unknown extension,
  a historical value outside a new UI bound, or text longer than a newly introduced
  cloud limit.
- If a legacy source cannot be safely uploaded, retain it durably and expose a bounded
  local-only/attention diagnostic; never ACK or delete it.
- Malformed/truncated JSON remains fail-closed, but its raw bytes stay in the append-only
  source and are surfaced through existing recovery/diagnostic evidence.

### 2. Prove the v0.3.8 rollout behavior

Choose and test one explicit policy per operation:

- Secure exact legacy acceptance, with auth-bound author, bounded rev, exact base shape,
  and no permanent clock pin; or
- Intentional old-client rejection plus proof that local JSONL/pending state survives
  restart and the v0.3.9 client durably creates and exactly ACKs one derivative.

Creation/join must not regain the old proof-free self-join vulnerability merely for
compatibility. If old create/join is intentionally rejected, the rules deployment is
gated behind the published v0.3.9 upgrade path and bilingual update-required handling.
Never deploy the hardened production rules before this gate is green.

### 3. Bind clock shadows and projections as far as Rules can prove

- Emulator adversarial cases must write syntactically valid ISO strings whose numeric
  shadows disagree, invalid calendar dates that match the regex, forged encoded IDs,
  and future-but-shadowed payloads.
- Clients reject every mismatch without ACK and without dropping the durable source.
- A family projection may reference only an immutable mutation in the same atomic write.
- Prevent a lower logical clock from replacing an existing projected winner. For equal
  clocks, use a rule-enforceable deterministic tie or require the client transaction to
  preserve/recompute the existing deterministic winner and test both write orders.
- A rejected/poisoned cloud document must not block valid siblings from syncing.

### 4. Atomic family lifecycle and invite collision handling

- `createFamily`: family + invite + exact user identity in one batch.
- Retry a cryptographically generated invite collision with a new code, bounded attempts,
  while keeping one family identity and never returning an orphan.
- Response-loss retry is idempotent and does not create a second family.
- `joinFamily`: deterministic per-user/per-code proof + own membership + exact user
  identity in one batch; retrying the same batch and later joining another family work.
- No list access, proof read, proof mutation, membership overwrite, or cross-user write.

### 5. Durable event derivative and exact ACK

- Preserve the original EventLog record byte-for-byte.
- Build one deterministic current-auth derivative for legacy author/mutation shapes.
- Append+fsync the derivative before any upload attempt.
- Upload the exact `{ event }` envelope to its content-bound immutable document ID.
- Remove pending only after a server read-back passes document ID and canonical payload
  equality. Already-exists with different bytes is not success.
- Crash/restart at every boundary converges without duplicate derivatives or lost
  originals; account A -> B never rebinds/deletes A's durable derivative.

### 6. Baby-info integration after Wave 4

- Use the bounded pending/archive paging APIs; do not materialize the full journal.
- Convert old pending shapes and pair-only cloud writes into a durable auth-bound HLC
  derivative, preserving the original and provenance.
- Upload then atomically project only the resolver winner.
- Exact ACK is content-bound. A same UUID/different payload, stale projection, permission
  failure, sign-out, restart, or config generation change retains pending work.
- Family A/B histories never cross, including delayed Firebase teardown/reactivation.

### 7. Production evidence

- Real Firestore Emulator tests cover all allow and deny branches above.
- Real packaged two-device E2E covers account creation, atomic family create/join, offline
  writes on both devices, same-id/rev collision, tombstone, restart, sign-out/in, old
  pending migration, and exact convergence.
- Production rules deployment is a separate final operation after v0.3.9 release/upgrade
  readiness. Record the deployed ruleset/version and keep the prior rules source for
  rollback. Do not weaken tests or deploy early because signing credentials are absent.
- Independent review must report Critical/Important/Minor `0/0/0`.
