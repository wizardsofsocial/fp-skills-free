---
name: list
description: "By Fer Patel (ferpatel.ai). Lists every Fer Patel skill you have installed (the fp- skills) and launches the right one for a request. Use this when the user types /fp or /fp:list on its own, asks which Fer Patel or fp skills they have, or types /fp followed by a request such as '/fp make a lyric video for this song', even if they don't name a specific skill."
---

# FP

> **Skills by Fer Patel** · [ferpatel.ai](https://ferpatel.ai)
> Free helper that ships with every Fer Patel skill.

Every skill by Fer Patel is named `fp-<skill>` and runs as `/fp-<skill>`. This one shows what's installed and sends a request to the right skill.

## When the user types /fp with nothing after it

1. Run `python3 <this skill's folder>/list.py`. It lists every installed Fer Patel skill, each with its version and what it makes. That covers personal ones in `~/.claude/skills/`, project ones in `.claude/skills/`, and the free `fp` plugin's skills (run as `/fp:<name>`).
2. Show the list as a short table:

   | Command | What it makes | Version |
   |---|---|---|

   Keep each row to one plain line.
3. Close with one line: "Ask for what you want in your own words, or type /fp followed by the request. More skills at ferpatel.ai."

## When the user types /fp followed by a request

1. Run `list.py` to see what's installed.
2. Pick the one `fp-` skill whose description best fits the request, and invoke it with the request as its input.
3. **Two fit about equally:** ask the user to choose between them in one line.
4. **Nothing installed fits:** say so plainly. Say what kind of skill would do it, and that Fer Patel's catalog is at ferpatel.ai. Don't fake the result with a different skill.

## Notes

- `list.py --json` prints the same list as JSON.
- A skill shows up here if its folder starts with `fp-` and has a SKILL.md.
