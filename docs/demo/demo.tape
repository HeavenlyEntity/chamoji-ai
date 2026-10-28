# The readme demo: three captioned screens, each held long enough to read.
#   1. a messy git log  2. `chamoji release`  3. the release commit and tag
# Render from the repo root after `pnpm build`:
#   vhs docs/demo/demo.tape
Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 880
Set Padding 32
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set WindowBar Colorful

Hide
Type "bash docs/demo/setup.sh && cd /tmp/chamoji-demo && export PATH=/tmp/chamoji-demo-bin:$PATH PS1='$ ' && clear"
Enter
Sleep 2s
Show

# 1. The starting point.
Type "# 1. Your commits, written however you like"
Enter
Sleep 500ms
Type "git log --oneline"
Sleep 300ms
Enter
Sleep 5s

Hide
Type "clear"
Enter
Show

# 2. The one command.
Type "# 2. One command cuts the release"
Enter
Sleep 500ms
Type "chamoji release"
Sleep 300ms
Enter
Sleep 9s

Hide
Type "clear"
Enter
Show

# 3. What it left behind.
Type "# 3. Committed and tagged, ready to push"
Enter
Sleep 500ms
Type "git log --oneline -3"
Sleep 300ms
Enter
Sleep 6s
