# Recording script for the README demo.
#
#   brew install vhs && vhs demo/story.tape
#
# Committed so the GIF is regenerable rather than hand-recorded. When a tool's
# output format changes, re-run this — a hand-made recording goes stale
# silently and nobody notices until someone believes it.
#
# Needs an nRF52840-DK attached and `npm run compile` already run.

Output demo/jlink-mcp-demo.gif

# Sized so the compact register line — about 190 characters of real output —
# fits without wrapping. Wrapping it three times is the difference between
# "look how much this condenses" and "look at this mess".
Set FontSize 13
Set Width 1560
Set Height 800
Set Theme "Catppuccin Mocha"
Set Padding 18
Set TypingSpeed 45ms
# Slow down the frame rate a touch: this is text, not motion.
Set Framerate 24

Type "node demo/story.js"
Sleep 400ms
Enter

# The script paces itself, so just let it run. Budget generously — flashing
# and the GDB server bring-up are the slow parts and they are real.
Sleep 60s
