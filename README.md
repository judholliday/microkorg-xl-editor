# microKORG XL Editor

A browser-based sound editor for the Korg microKORG XL. It replaces Korg's old Sound Editor, which no longer runs on current macOS. It talks to the synth over USB using the SysEx protocol in Korg's official *microKORG XL MIDI Implementation*.

## Start it

0. Install [uv](https://docs.astral.sh/uv/) once (`brew install uv`). It fetches the right Python and the AI packages automatically the first time the editor starts. Without it, the editor still runs on the Mac's own Python, with Claude Code as the only AI option.
1. Connect the microKORG XL by USB.
2. Double-click **`Start Editor.command`**. It serves the page on `http://localhost:8765` and opens it in Chrome (or Edge).
   - If macOS blocks it the first time, right-click the file, choose **Open**, then confirm.
   - Safari isn't supported because it has no Web MIDI.
3. Allow MIDI/SysEx access when the browser asks.
4. On the synth, set **GLOBAL › MIDI Filter › SystemEx** to Enable. Also enable **ProgChg** if you want the editor to follow program changes made on the synth.

**Korg's factory sounds** aren't included in the public copy of this project, since they're Korg's to share. Download Korg's microKORG XL software (the Sound Editor/Librarian package) from Korg's website and copy its factory preset files (`.mkxl_all`) into the `presets/` folder; they then appear in the Presets tab. Converted libraries made by this project (Prophet-5, Juno-60, Polysix) are included. Korg's *MIDI Implementation* document, used only to regenerate `js/fxdata.js`, is also on Korg's site.

The editor finds the synth automatically and loads the current program. The XL appears as four MIDI ports: **KBD/KNOB** and **SOUND** are the synth; **MIDI IN/OUT** are just its 5-pin sockets. **Find synth** picks the right pair for you. The **Help** tab inside the app covers the rest.

**Synth not found?** Quit and reopen Chrome with the synth plugged in. Chrome can silently stop passing SysEx to web pages, notably while it has an update waiting, even though notes still arrive.

## What it does

- Edits every program parameter: both timbres (oscillators, filters, amp, drive, 3 EGs, 2 LFOs, 6 virtual patches, EQ, panel knob assignments), both effects (all 17 types), the arpeggiator, scale and voice mode, and the 16-band vocoder.
- Updates the synth live as you edit. Nothing is stored until you **Write to slot**.
- Follows the synth: turning a knob on the synth, or changing programs on it, updates the editor.
- **Presets:** browse, search and audition everything in the `presets/` folder: the 512 sounds from Korg's original software (XL factory sounds, plus Korg's conversions of the microKORG and MS2000 banks), and classic synths' factory patches converted for the XL: the 1978 Prophet-5 (38), Roland Juno-60 (56) and Juno-106 (128), Korg Polysix (64) and Moog's Minimoog Sound Charts (49). The Juno-106 and Minimoog libraries aren't in the public copy: their sources allow personal use only, or require the GPL. Drop in more `.mkxl_all` or `.syx` files and they appear after a reload.
- **AI Designer:** describe a sound ("squelchy acid bass", "warm pad with slow attack") and the AI builds it, using the presets as references (and the web, where the provider can search), then sends it to the synth. Pick 1–4 variations per request. Click a sound in Recent designs to load it; your next request then modifies it ("brighter", "less echo") until you choose Start a new sound. It may only look up presets and search the web; it can't change files or run anything. Typically 10–60 seconds with a cloud model.
- **AI settings** (⚙ in the AI Designer tab) choose the AI provider for both the AI Designer and the sequencer's AI patterns:
  - **Claude Code**: uses the `claude` command with your own Claude login. No API key.
  - **Anthropic API**: an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). Default model Claude Opus 5.5.
  - **OpenAI-compatible**: OpenAI, Google Gemini, OpenRouter, or a model on your own computer with [Ollama](https://ollama.com) or LM Studio (free, but slow; choose a model that fits in memory, and in Ollama's Settings raise **Context length** to 16k or more for sound design). Web search isn't available through these.
  
  Keys are saved in `data/settings.local.json` on this computer, which is never committed; environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) work too.
- **Poly / Mono:** a badge next to the sound's name (and on every preset tile) shows whether it plays chords (**Poly**), one note at a time (**Mono**), or both (**Mono+Poly**: a Layer, Split or Multi sound with one timbre of each). Hover it for which timbre does what. The **Voices** filter in Presets shows just one kind.
- **Organizing presets:** group by type, bank or category, sort by name, and filter by type, category or bank. Types are guessed from each sound's name and settings; change any with ✎ (or Option-click a tile), including your own new types. Your choices are saved in `data/sound-types.json`.
- **My Sounds:** **Add to My Sounds** keeps any sound (an AI design or your own tweak) in a collection on this computer (`data/my-sounds/`, one `.syx` per sound). It shows as the first bank in Presets, the AI can use it as a reference, and removed sounds go to `data/my-sounds/deleted/`. **Export My Sounds as .syx** saves the whole collection as one file; **Import .syx into My Sounds** adds every sound from a file.
- **Recent designs:** every AI request and its results are saved in `data/ai-designs/` (one `.json` per request), even if the page is closed while it runs. The AI tab lists the latest; click one to load it. **✕** removes one from the list (marked in its file); **Removed** at the bottom brings it back. **Add to My Sounds** puts a sound in Presets.
- **Library:** reads all 128 programs, saves them as a single `.syx` backup, and can write a bank back.
- Opens `.syx` files and Korg Sound Editor files (`.mkxl_all`), and saves `.syx`, with or without the synth connected. Patches for the original microKORG use a different engine and can't be loaded.
- Lets you audition sounds with an on-screen keyboard, or with the computer keys `A`–`K`.

## Sequencer

Switch between **Sound Editor** and **Sequencer** at the top of either page (or open http://localhost:8765/#sequencer). Both stay running, so the sequencer keeps playing while you edit sounds. It plays patterns to the XL, your other MIDI gear, or a built-in test sound on the computer.

- **Tracks** (up to 8): each has its own output and MIDI channel, four patterns (A–D), a step rate (1/32 to 1/4, including triplets), mute (M) and solo (S), and a **Vol** slider. For the computer sound it sets the track's loudness (100 is normal; above that boosts up to 4×); for MIDI gear it sends MIDI Volume (CC 7) when you move it, and at Play if it isn't at the default 100. Choose **Computer (test sound)** as the output to hear a track without any instruments connected; its **Sound** can be Bass, Pluck, Pad, Keys or **Drums** (a synthesised kit on the standard General MIDI drum notes, so library drum patterns play on it). Drum tracks show drum names (Kick, Snare, Hat…) on their steps.
- **Drum tracks** (named like "Drums", or using the Drums sound) show a drum-machine grid instead: one row per drum, one column per step. Click or drag along a row to add or remove hits, ⇧-click a hit to accent it, click a drum's name to hear it, and **+ Add a drum** for more rows. Click a step number to open that step in the editor, which shows a kit of pads instead of a keyboard. Drums hitting on the same step share its velocity.
- **Sounds:** a track playing the XL (its SOUND port) remembers an XL sound, shown on its **🎛** button. When playback starts, a track with no sound yet takes the one in the Sound Editor, and its sound is sent to the XL. Click 🎛 to send the sound and open it in the Sound Editor; edits you make there (or sounds you pick from Presets, or programs you change on the synth) are remembered for that track, and saved with the song. The XL plays one sound at a time, so with several XL tracks the one you last sent wins. With **XL sound follows selected track** (on by default), selecting a track (click it, or press 1–8) switches the XL to that track's sound, for quick switching while playing. Tracks on other gear have a **Prog** menu: a Program Change sent when playback starts and when you change it.
- **Steps:** any pattern length from 1 to 64. Up to 32 steps fit on one page; longer patterns page in 32s. Each note has its own notes (several make a chord), velocity, gate, and how many steps it's held for. Drag a note's right edge to hold it longer.
- **Note pool:** instead of fixed notes, the steps set the rhythm and each one that fires plays the next note from the pool. Play a chord on your keyboard to change the pool while it plays, and choose the order (as played, up, down, up-down, random). With **Latch** off, it plays only while you hold keys.
- **Song:** a grid of sections. Each section has a length in bars and a pattern (or silence) for each track. **Loop patterns** plays each track's current pattern instead; pattern buttons then switch at the next bar.
- **Keys in:** notes from your keyboard go to the selected track, while the Sequencer is on screen. The light next to it flashes green for notes on the chosen port, or amber (with the port's name) when notes arrive on a different one. With the step editor open and the sequencer stopped, they fill in the selected step (hold several for a chord) and move to the next one. **Thru** also plays them on the track's output; turn it off if your keyboard makes its own sound (the XL does unless its Local Control is off).
- **● Rec** (or press R): while playing, the keys you play on the Keys in keyboard are recorded into the selected track's playing pattern, on the nearest step and held as long as you held the key. Notes are added to what's already there, so you can build a part up over several loops. One Undo removes everything recorded in one run. Works on Steps tracks (on a note-pool track, keys set the pool as usual).
- **Capture:** everything you play on the Keys in keyboard is kept for an hour, whether or not you pressed Rec, the sequencer was playing, or you were in the Sound Editor. Playing is split into takes wherever you stopped for 4 seconds. Each take shows a little piano roll; **▶** plays it on the selected track's sound, **→ Track A** puts it into the selected track's shown pattern (quantized to the track's steps; Undo brings back what was there), **.mid** downloads it as you played it. A take played along with the sequencer lands on the bars it was played in. A take played freely starts on its first note, at a guessed tempo; change **BPM** if the bars look wrong, and **Song to …** sets the song to that tempo. Takes longer than a pattern can hold get a **From bar** choice. Takes are kept in this browser only: put the good ones into a track or a .mid file.
- **Export .mid** (next to Delete) downloads the song as a MIDI file: its sections played once through, one MIDI track per sequencer track (muted tracks too), with swing and note pools as they sound. Drag it into Ableton Live's Arrangement view to arrange, mix and add audio there.
- **Clock out:** sends MIDI clock and start/stop to the outputs you tick, so other gear follows the tempo. Set the XL's Clock to Auto or Ext-USB to sync its arpeggiator.
- **Scale:** dims notes outside the scale and snaps notes played on your keyboard into it.
- **✨ AI** (in each track's header): Claude writes patterns for that track. Describe what you want (or leave it blank), then choose the role (bass, lead, chords, pad, arpeggio, drums), density, register, whether to start from scratch or vary the current pattern, whether to fill just this pattern or all four (A main, B variation, C fill, D breakdown), and whether it should fit the other tracks. Ask for up to 3 options. **🎲 Surprise me** in the panel asks for three varied ideas without needing a description.
- **🎲** (in the track header): an instant random pattern, no AI and no wait. It follows the song's scale and the role, density and register set in the ✨ AI panel (Auto by default). Click again for another.
- **📚 Library** (in the track header): stock patterns for common styles (house, techno, disco, boom bap, trap, breakbeat, drum & bass, reggaeton, funk, bossa nova, dub… drums, basslines, chord progressions and pads, arpeggios, riffs, and note-pool rhythms), plus your own. It shows patterns for the track's role (choose All to see everything); search by name or style. Click one to hear it in the pattern on screen; it's moved to the song's key. **★** saves the pattern on screen to your library (`data/my-patterns/`, one `.json` each); 🗑 moves one to `data/my-patterns/deleted/`.
- **Ideas:** everything 🎲, the AI and the library come up with lands in the track's list of ideas (up to 12) and plays at once. Click a number to hear an idea, even while playing; **Original** goes back to what you had. **✓ Keep** keeps what's in the pattern and clears the list; **Put in** copies the idea you're hearing into another pattern (A–D), so you can keep several. It uses the song's tempo, swing and scale, typically takes 15–40 seconds, and runs through your Claude Code login with no tools (it only sees the song).
- **Save** keeps songs in `data/sequences/` (one `.json` per song); **Delete** moves them to `data/sequences/deleted/`. The song you're working on is also kept in the browser, so a reload doesn't lose it. Undo with ⌘Z.

Keys: Space play/stop, R record, ← → move between steps, ↑ ↓ transpose (⇧ for an octave), Enter add a note, ⌫ delete, Esc close the step editor.

## Before you edit

Back up first: go to **Library › Read all from synth › Save bank .syx**.

## Files

| Path | Purpose |
|---|---|
| `Start Editor.command`, `serve.py` | Launcher and local server (static files, preset list, AI Designer bridge to Claude Code) |
| `index.html` | Hosts the editor and the sequencer together, so switching between them never stops playback |
| `editor.html`, `style.css`, `js/app.js` | The editor UI |
| `js/korgfile.js` | Reader for Korg Sound Editor files (`.mkxl_all`) |
| `js/aiparams.js` | Readable parameter values for the AI, and applying its answers |
| `tools/build_ai_reference.mjs` | Builds `ai/` (AI instructions, preset index, preset settings); `serve.py` reruns it when presets change |
| `js/sysex.js` | SysEx message building/parsing and Korg's 7-bit data packing |
| `js/params.js` | Parameter map: byte offsets, bit fields, value display, Parameter Change IDs |
| `js/fxdata.js` | Effect definitions, generated from the spec by `tools/gen_fxdata.py` |
| `tools/selftest.mjs` | Offline checks: `node tools/selftest.mjs` |
| `tools/fakesynth.js` | Simulated synth for testing without hardware: open `http://localhost:8765/?sim` |
| `sequencer.html`, `sequencer.css`, `js/seq/` | The sequencer: data model, timing engine, test synth and page |
| `tools/seqtest.mjs` | Sequencer checks (run by `selftest.mjs`) |
| `ai_providers.py` | The AI providers (Claude Code, Anthropic API, OpenAI-compatible), AI settings and the preset tools |
| `tools/providertest.py` | Offline checks for the AI providers: `python3 tools/providertest.py` |
| `tools/pattern_prompt.md` | The AI's instructions for sequencer patterns (sound design's are generated into `ai/system.md`) |

## Known unknowns

These parts were checked against the spec and a simulated synth but not yet against real hardware:

- **Send: Parameter mode** (one message per change). The spec is ambiguous about byte order and how signed values are encoded. The editor calibrates itself the first time you turn a bipolar knob on the synth. If parameter mode misbehaves, switch to **Send: Whole program**, which uses only the full-program dump format that the spec documents unambiguously.
- The spec gives the program dump size as both 342 and 346 bytes. The editor always sends back data at the length the synth sent it.
- Two quirks found in Korg's own preset data: Chorus "LFO Spread" is often stored as 146, outside the documented range (shown as +180°), and the Time Ratio table repeats 100% five times. The editor leaves such values untouched unless you change them.
- PCM/DWGS waveforms are shown by number, because their names are listed in the owner's manual, not the MIDI spec.

## Where your sounds are kept

| What | Where | Survives restarting? |
|---|---|---|
| The sound you're editing | Only in the editor and the synth's edit buffer | No, until you save it |
| Programs on the synth | The synth's 128 slots (**Write to slot**) | Yes, on the keyboard |
| My Sounds | `data/my-sounds/`, one `.syx` per sound | Yes, on this Mac |
| Your sound types | `data/sound-types.json` | Yes |
| AI designs | `data/ai-designs/`, one `.json` per request with all its variations | Yes |
| Sequencer songs | `data/sequences/`, one `.json` per song (the open song is also kept in the browser) | Yes |
| Saved patterns (★) | `data/my-patterns/`, one `.json` per pattern | Yes |
| Captured playing | In the browser, for an hour | Only in this browser; save takes as patterns or .mid |
| AI settings and API keys | `data/settings.local.json` (never committed) | Yes |
| Backups | Any `.syx` you save: one sound, a bank of 128 (Library › Save bank), or all of My Sounds (Export) | Yes, wherever you save it |

A `.syx` file can hold one sound or many.

**Your `data/` folder is its own git repository**, separate from the app's. The editor creates it on first start and **commits automatically** a moment after every save, so there's a history of every sound, song and pattern (`git -C data log` to see it). Nothing is pushed anywhere; to back it up online, add a private remote of your own (e.g. a private GitHub repository) and push to it. Removed items go to `deleted/` folders, and API keys, which are never committed. Set `MKXL_DATA` to keep the data somewhere else.

## License

MIT (see `LICENSE`). Korg's factory sounds and documents, and the original patch charts the converted libraries come from, belong to their owners.
