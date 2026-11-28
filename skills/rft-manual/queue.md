# The experiment queue

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

There is no queue until this machine is paired with it. Until then there is no `rft_queue`, no
runner and no monitor: run an experiment as the user asks, and never set a queue up on your own.

**Pairing** (only when the user asks to set up the queue, or `/rft-machine add` asked you): the
plugin checks the machine itself (`rft_machine {action: "probe"}`, or the check `/rft-machine add`
handed you): its NVIDIA GPUs, the disks for the runs' outputs (the most room first), conda and
uv. Do not inspect the machine by hand for it. A machine with no NVIDIA GPU cannot be paired: say
so, and the queue stays off. Otherwise ask the user, in one AskUserQuestion with two questions,
where the runs' outputs go (the suggested folder first) and which GPUs to keep out of the queue
for their own work (none by default), then `rft_machine {action: "add", runs_dir, keep_out}`.
It answers what is on and the queue's rules; the queue tools load from the next turn. On a
machine already paired it changes nothing and says so. `rft_machine {action: "status"}` says how
it stands. Only the machine the session runs on can be paired for now.

**Once it is on, every run of an experiment's code goes through the queue** (with `gpus: 0` for
one that needs no GPU), never into the background with Bash (`&`, nohup, screen, tmux), nor in the
foreground beyond a check of a few seconds: a job is a command, the folder it runs in and how many
GPUs it takes, for one experiment. A **runner** (a
process of its own, apart from any session) starts each job once enough GPUs are free and records
how it ended, so a run outlives the session that queued it. Watching it costs no turn: the user
follows the GPUs, the queue and the history in the tree view's monitor (the icon at the top left,
or `/rft-jobs`), where they also reorder, pause, cancel and retry jobs, and keep GPUs out of it.

- **Queue a run** with `rft_queue {exp, cmd, cwd, gpus, label}` once its experiment note exists
  (`rft_add_node`, status planned). `gpus` defaults to the note's `gpus:`, else 1; 0 runs it with
  no GPU (it never waits). `label` tells the experiment's runs apart ("seed 2", "lr 3e-4"). The
  answer says its place in line and why it waits. Put it first in line (`top`) only when the user
  asks.
- **The command** runs as `bash -c <cmd>` in `cwd`, in a session of its own, with
  `CUDA_VISIBLE_DEVICES` set to its GPUs (numbered as nvidia-smi numbers them), `RFT_JOB`,
  `RFT_EXPERIMENT` and `RFT_OUT`. It has the session's environment only, not your shell's: activate its conda
  or venv in the command (`source <conda root>/bin/activate env && python train.py ...`; the
  conda root and its envs are in `rft_machine status`) or give the interpreter's full path. Check the command once by hand (a dry run, `--help`) before queueing
  a long run. Its log goes to `<vault>/.queue/logs/<job>.log`.
- **Its outputs** go to `$RFT_OUT`, a folder of its own: `<root>/<repo>/<exp>/<job>` under the
  outputs' root chosen when the machine was paired (`<repo>` the name of the job's repo folder),
  else `<repo>/runs/<exp>/<job>` (kept out of git). Have the
  command write there (`--out "$RFT_OUT"`); the notebook finds it as `out` in `RUNS`.
- **How far it is**: the monitor and `rft_jobs` show, for each running job, its stage, one tqdm
  bar (label, n/total, %, time left, postfix) and its last line, read from what it writes. To say
  how far a job is, read `rft_jobs`, not its log. A script you write or change for the queue
  follows "Writing a job the monitor can read", below.
- **The run record**: when a job starts, the runner records the code it runs (repo, commit,
  branch; uncommitted changes saved whole as `code.patch` in its output folder); when it ends,
  a failed one's traceback, and whether the repo's code moved while it ran. Each output folder
  holds its record (`rft-run.json`). `rft_jobs <job>` shows them; a run can be made again from
  its commit, its patch and its command.
- **Order** is strict: the first waiting job that needs GPUs takes them once enough are free, and
  nothing behind it starts first. A GPU with a process of someone else's on it, or more than
  1000 MiB of memory taken, counts as busy.
- **Do not poll.** The plugin sets the experiment running when its job starts and tells the user
  when one ends. Read `rft_jobs` when the user asks, or when the session starts with "Jobs that
  ended, their result not recorded yet". Where the notebook wrote the numbers, they are in the
  Result already: read it and say what they mean. Otherwise `rft_jobs <job>` says how it ended (a
  failed one with the end of its traceback; `log: 40` for more of its output); then record the
  real result, or the failure and its cause; a failed run may deserve a fix and `rft_queue` again,
  after the user agrees.
- **Change the queue** only when the user asks (the order is theirs), with `rft_job {action}`:
  `move` one waiting job to `"top"`, to `"end"`, or before another waiting job (`before: "q3"`),
  answered with the new waiting order in one line (no `rft_jobs` after it); `cancel` one (it
  leaves the experiment's status to you); `retry` one that ended (first in line again); `pause`
  the queue (no new job starts; the running ones go on) and `resume` it. "Run E17 before E16":
  find their jobs (the session's list, or `rft_jobs` once), then one call,
  `{action: "move", id: "q4", before: "q3"}`.
- `rft_next` lists what runs and waits, and the results to record.
- The queue lives in `<vault>/.queue/` (`machine.json`, the machine it is paired with;
  `queue.json`; the history in `history.jsonl`), out of git; edit none of them by hand.

### Writing a job the monitor can read

The monitor and `rft_jobs` read three things a job writes: its tqdm bars, its lines of text, and
`$RFT_PROGRESS`. When you write or change a script that runs through the queue:

1. **A tqdm bar on each loop longer than a minute**, with a fixed `desc` and a `total`:
   `tqdm(loader, desc="train", total=len(loader))`. The monitor shows one bar per job: the
   outermost still running (the epochs, not the batches inside them).
2. **Numbers that change go in the postfix, never in the label**:
   `bar.set_postfix(loss=f"{loss:.4f}")`, not `bar.set_description(f"train loss {loss:.4f}")`.
   The monitor shows the postfix after the bar.
3. **Inner loops** get `leave=False`. Leave `mininterval` alone: the runner sets 10 s
   (`TQDM_MININTERVAL`), so a bar redraws every 10 s and logs stay small.
4. **Stages**: a job of several steps appends one line per step to `$RFT_PROGRESS`, a JSON
   object `{"stage": "train", "i": 2, "n": 3}` (or a plain line of text). From bash:
   `echo '{"stage": "probe patchpos", "i": 2, "n": 5}' >> "$RFT_PROGRESS"`. The monitor shows
   "Stage 2/3: train" above the bar.
5. **Lines of text**: one per event, starting with the time (`2026-11-16 12:00:05 epoch 7: val
   acc 0.912`), written as they happen (`print(..., flush=True)`, or `PYTHONUNBUFFERED=1`). The
   last one shows under the bar. Nothing per batch.
6. **Results go to `$RFT_OUT`**, never into the log: no arrays, tables or per-sample prints.
7. **Failures raise**: let the exception end the job with its traceback (the runner keeps its
   end, and `rft_jobs` shows it) and a non-zero exit; never catch it and only print.

`examples/job_progress.py` in the plugin's folder does all of this in 50 lines; start from it.
Code the user wrote that does not follow it still works: the monitor then shows less.
