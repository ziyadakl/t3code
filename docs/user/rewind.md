# Rewind

On web and desktop, choose **Edit from here** beneath a sent message to rewind
to before that message. If a turn is still running, the click stops it first,
then rewinds.

Press `Escape` to stop a running turn. Press `Escape` twice to open a list of
earlier messages: pick one with the arrow keys or the mouse, then press `Enter`
to rewind to before it.

## Claude threads

In a Claude thread, **Edit from here** first asks Claude whether a rewind
would change any files. When Claude changed no files after that message, the
conversation rewinds straight away and the message returns to the composer.
Claude's snapshots only track files it changed with its own edit tools, not
files changed by shell commands. When it did change files, **Edit from here**
opens the same menu as Claude Code's `/rewind`, in any folder, git repository
or not, including threads imported from Claude:

- **Restore code and conversation** puts your files and the chat back to before
  the message.
- **Restore conversation** rewinds the chat and leaves your files as they are.
- **Restore code** puts your files back and keeps the chat.
- **Never mind** closes the menu with no change.

The two code choices use Claude's own file snapshots, not git. While T3 Code
asks Claude what a code restore would change, they stay disabled. They become
available only when Claude changed files after that message; the menu then
shows how many files and lines would change, or why there is nothing to
restore. Like Claude Code, a code restore does not undo changes made by Bash
commands or by subagents. When Claude leaves a file alone because a link made
it unsafe to write, a notice says how many files were skipped.

After **Restore code and conversation** or **Restore conversation**, the
selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt. Your next message
continues Claude's own session from that point, so Claude forgets the later
turns. If the code is restored but the conversation rewind fails, a notice says
so; choose **Restore conversation** to try again.

A rewind is refused while a message waits in the queue; send or remove it
first. Claude Code's two summarize choices are not offered yet.

## Other providers

Other providers revert to a checkpoint instead; see [Edit an earlier prompt](./composer.md#edit-an-earlier-prompt).
