# GitHub Copilot

GitHub Copilot runs the [Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) on
the machine hosting your environment, through Copilot's own SDK. It is disabled by default.

## Set up Copilot

Install the Copilot CLI on the host and run `copilot login` as the account that runs T3 Code.
Open **Settings → Providers**, select the environment, and enable **GitHub Copilot**. Set
**Binary path** if `copilot` is not on the host's `PATH`, then refresh provider status. The
status shows the signed-in GitHub account.

If Copilot is started through a wrapper, set **Binary path** to the wrapper and put the
arguments that select Copilot in **Launch arguments**. For a `launcher copilot` command, use
`launcher` as the binary path and `copilot` as the launch argument. T3 Code adds Copilot's own
server arguments after them.

Copilot inherits `GH_TOKEN`, `GITHUB_TOKEN`, and `COPILOT_GITHUB_TOKEN` from the host. Turn on
**Hide GitHub tokens from Copilot** to start it without them so it uses its own sign-in.

Copilot keeps its sign-in and sessions in `~/.copilot` on the host, so Copilot threads started
in T3 Code also appear in the Copilot CLI's session list. Instances on the same host share that
login.

## Models

The model picker lists the models your Copilot plan offers on the host, starting with **Auto**,
which lets Copilot choose. Add a model id under **Custom models** in the instance settings to
use one the list does not show. Reasoning choices appear for models that support them, and
**Context Window** appears for models with a long-context tier, which Copilot bills at its own
rate. You can change the model, reasoning level, or context window between messages in the same
thread.

## Permissions, plans, and questions

Copilot offers two [permission modes](./permission-modes.md). **Supervised** shows each
Copilot permission request in the conversation. **Deny** lets Copilot continue without that
action; **Deny and stop** ends the turn. **Full access** turns on Copilot's own allow-all
mode, which approves its tools, files outside the project folder, and URLs. Copilot can still ask when
your organization's policy requires approval, or before it runs a file tool outside its sandbox.

The composer's **Plan** toggle puts the message in Copilot's plan mode. When Copilot finishes
its plan, it appears as a proposed plan and Copilot stops there until you reply or ask it to
implement the plan. When Copilot asks you a question, answer it in the question panel.

## Working with turns

Send a message while Copilot is working to steer the running turn; Copilot reads it at its next
step. **Stop** ends the turn; if Copilot does not confirm within a few seconds, T3 Code detaches
the session, which also ends any command Copilot was running. A new message fails while Copilot
is still busy with work T3 Code did not start, such as a session another Copilot CLI is running.
Reverting to an earlier checkpoint also rewinds Copilot's conversation to that point. Copilot
cannot rewind to just before a turn in which it picked up a background subagent's result; revert
to before the turn that started that subagent instead.

Copilot can use T3 Code's tools. If Copilot cannot reach them, the turn continues without them.
Copilot's built-in GitHub MCP server is turned off in T3 Code threads.

When Copilot delegates to a subagent, the subagent appears as its own row in the turn and opens a
child thread with its prompt, tool calls, and messages. A subagent Copilot runs in the
background keeps working after the turn ends, so you can keep chatting; when it finishes, Copilot
picks up its result in a new turn of its own. Stopping a subagent cancels only that subagent.
**Stop** on a running turn leaves background subagents running; Stop again once no turn is
running to end them too. Subagent messages arrive whole rather than streamed.

Forking a Copilot thread, whole or from an earlier turn, copies Copilot's own conversation up to
that point into a new Copilot session. Work after the chosen turn, such as a conversation
continued in the Copilot CLI, stays out of the copy. While Copilot is still working in the
session, forking from its last turn fails; try again once it is idle.

When the conversation nears the model's context limit, Copilot compacts it in the background and
the turn shows the compaction with its summary. Set **Auto-compact at** in the instance settings
to compact earlier, as a percent of the context window, or send `/compact` to compact now.

**Usage → Limits** shows how much of your Copilot plan's monthly request allowance is left.
Unlimited allowances do not appear there.

Copilot can generate thread titles, branch names, commit messages, pull request text, and review
guides. These run in short-lived Copilot sessions without tools (review guides may only read and
search files in the checkout, with Copilot's own tools) that are deleted afterwards and kept out of Copilot's session history. Their
tokens, like those of Copilot threads, appear on the **Usage** page under **GitHub Copilot**.

Copilot threads load the same skills, custom agents, and MCP servers as the Copilot CLI: the
project's (for example `.github/skills`, `.github/agents`, and `.mcp.json`) and your own in
`~/.copilot`. T3 Code adds each project folder it opens to Copilot's trusted folders, as
answering yes to the CLI's trust prompt would, so the project's MCP servers start. Type `$` or
`/` in the composer to pick a skill; T3 Code sends it as Copilot's `/skill-name` command, with
the rest of the message as its arguments. Copilot runs one skill per message this way, and a
message sent while a turn runs names the skill for Copilot to load itself. Copilot's built-in
slash commands are not offered, since T3 Code has its own controls for them.

## Copilot through the ACP Registry

A local `copilot --acp` command in the [ACP Registry](./providers-acp.md) also works, but it
cannot steer a running turn or rewind the conversation, and T3 Code answers each tool request in
place of Copilot's own allow-all. Prefer the GitHub Copilot provider.
