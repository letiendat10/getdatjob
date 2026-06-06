-- Relax jobs_department_chk so the department source-of-truth pipeline can store the new
-- buckets it is DESIGNED to coin.
--
-- card_guardrails (20260603000007) pinned jobs.department to the fixed canonical 15. Two days
-- later the SoT pipeline (20260605*) began folding raw ATS departments via dept_mapping, whose
-- LLM pass deliberately proposes NEW Title-Case buckets for org areas the seed 15 don't cover
-- (Healthcare, Manufacturing, Field Service, ...). The enum CHECK forbade exactly those values,
-- so restamp_department() — a single set-based UPDATE — threw 23514 on the first non-canonical
-- row and aborted the WHOLE batch: 0 jobs ever re-stamped, every nightly run.
--
-- The vocabulary is now governed by dept_mapping (curated rule -> llm -> human) and reviewed at
-- /admin/departments, so a hard enum on the column is redundant AND breaking. Swap it for a
-- lightweight guard that keeps the card_guardrails intent (no empty/garbage value can reach a
-- card) without freezing the taxonomy. Drop-then-add so the migration is safely re-runnable.
alter table public.jobs drop constraint if exists jobs_department_chk;
alter table public.jobs add constraint jobs_department_chk check (
  department is null or char_length(btrim(department)) between 1 and 60
);
