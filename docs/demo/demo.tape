# The readme demo. Render from the repo root after `pnpm build`:
#   vhs docs/demo/demo.tape
Output docs/demo.gif

Set Shell "bash"
Set FontSize 20
Set Width 1200
Set Height 760
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WindowBar Colorful

Hide
Type "bash docs/demo/setup.sh && cd /tmp/chamoji-demo && export PATH=/tmp/chamoji-demo-bin:$PATH PS1='$ ' && clear"
Enter
Sleep 2s
Show

Type "git log --oneline v1.2.0..HEAD"
Sleep 300ms
Enter
Sleep 3s

Type "chamoji changelog --from v1.2.0"
Sleep 300ms
Enter
Sleep 5s

Type "clear && chamoji release | head -n 6"
Sleep 300ms
Enter
Sleep 4.5s
