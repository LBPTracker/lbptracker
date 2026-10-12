# Changelog

What changed for the person using LBP Tracker, newest first. The site shows this file behind the
version number in its status bar, so it is written for them: what they can do now that they could
not before, never how it was done. No `--` or em dash in here; the site's text does without them.

## 0.2.44 (2026-10-12)

- Every song now keeps the game's own time. Notes start and stop on the same small grid the game
  uses, a few milliseconds after the step rather than exactly on it, and their glides, swells and
  filter sweeps follow the game's own arithmetic. Played or exported, a song now matches what the
  game's synthesiser produces from the same notes, to well below anything you could hear.
- Playing a song in the tracker and exporting it now give the same sound. Groups of notes used to
  land a few milliseconds early or late against each other while playing, depending on when the
  computer got round to them.
- Exporting takes longer, about half again, to compute the filter exactly as the game does.
- Our own master bus, the glue and the limiter, is where every song starts again. The game's own
  is still one choice away: it is what the game would play, and it is quiet, 5 to 7 dB below ours.
- The master bus has four choices, under Song/Mixer and in the Render view: none, game, AGC and
  glue. The G beside the volume is gone; Song/Mixer is the one place to pick it.
- New: AGC, the game's own master bus with an automatic volume after it, which turns a song
  towards a comfortable level as it plays and keeps it from going over the top. It finds a song's
  level in its first seconds and then moves slowly, so the quiet and loud parts of a song mostly
  stay as they were. The Song/Mixer card shows how far it is turning the sound up.

## 0.2.43 (2026-10-11)

- The master bus is now the game's own, and it is where every song starts: the compressor the
  game ends every song with, and the way a television folds the game's surround sound into two
  speakers, which pulls every instrument a little towards the middle so that nothing is panned
  hard to one side. Busy songs play a few decibels quieter than before and no longer go over the
  top.
- Our own master bus, the glue and the limiter, is still there as the other choice, under
  Song/Mixer and on the G beside the volume, which now switches between the two. The Render view
  has the same choice, and the Keyboard view plays through whichever one is picked.
- Every instrument has now been checked against the game's own synthesiser, run on the same notes,
  and the differences it found are gone. The ones you may hear:
  - Notes whose modulation moves now swell and fade as in the game. The filter, the envelopes,
    the drive and the echo send followed the modulation too early, and on some instruments, the
    square wave and the electric harpsichord among them, the difference was plain.
  - Filters that follow the keyboard now follow a pitch glide as the game does.
  - Drum kits and other sounds that ignore the note no longer bend when a note glides.
  - Choirs, strings, the electric piano and the noisy sounds (noise, record static, mosquito) now
    start their second layer where the game does, which changes their texture at high
    modulation.
  - Struck sounds such as the woodpecker stop when they have died away, as in the game, and give
    their voice back to other notes sooner.
  - Drum hits and other sounds that play their sample once now end as in the game: their filter
    and their other layers ring on for the last few milliseconds, where the tracker cut them off
    the moment the sample ran out.
  - A song with nine rows or more now plays as the game does when its first eight rows are all
    busy: the game then skips the rows below them, and so does the tracker. Where two chips
    overlap on one row, only the later one plays, as in the game.
  - The reverb's early echoes arrive when the game's do, a few milliseconds later than before on
    most settings.
  - A note with several points packed into one step now lasts as long as it does in the game. The
    game moves through a note's points one step at a time, so such a note sounds a step longer than
    its last point.
- The reverb rings on while a song plays when you change the tempo, the swing, a fader or the
  echo, or edit the song, as in the game. Each of those used to silence it and start it again
  from nothing. Choosing another reverb keeps it ringing too, and, as in the game, keeps
  something of the first room: switch the reverb off and on for a fresh one.

## 0.2.42 (2026-10-05)

- Short notes no longer click at their start and end. On some instruments, the triangle wave most
  of all, the first and last moments of a note were cut more sharply than in the game, by an
  amount that depended on where the note fell, so the clicks seemed to come and go at random.
- Two more clicks are gone, ones the game itself seems to make: the triangle wave's very fast
  release on low notes, and some hits of the synth percussion kit a moment after they end. The
  tracker now fades both out over a fiftieth of a second.
- The Ableton Live export sends each track into the Echo as the game does. Some tracks went into
  Live's echo far louder than into the game's, often by about 20 dB, and some echoed in Live where
  the game does not echo them at all.

## 0.2.41 (2026-10-04)

- The Ableton Live export carries the swing: unless you bake it into the notes, it is a groove in
  Live's Groove Pool that every clip follows, so the notes stay on Live's grid and still swing.
- Every clip is as long as its chip on the board, empty bars included, instead of stopping at its
  last note.
- New option, off by default: our master bus on Live's master track, a Compressor set as the glue
  and a Limiter, at the glue the Song/Mixer card is set to. With it the set plays about as loud as
  the tracker does with its master bus on.
- With the instruments, every track played far louder than the game, so the master had to come
  down by about 20 dB to stop clipping. It now plays at the game's level.
- With the instruments, a row whose chips are in different keys played some notes on the wrong
  sample, a drum kit's closed hi-hat on its tom. Every note now plays its own sample at its own
  pitch, and keeps the note number the tracker's piano roll shows. Live names the octaves one
  lower: C3 in the tracker is C2 in Live.
- With the instruments, filters that follow the keyboard sat too closed or too open in Live; the
  ghost was much too dark. They now follow the game.
- With the instruments, a note whose modulation moves now moves its level and its filter in Live
  as it does in the game, so swells and filter sweeps come through, at the game's speed. The rest
  of the instrument stays at the modulation its track uses most.

## 0.2.40 (2026-10-04)

- The audio readout in the status bar is now one figure, like a DAW's CPU meter: "17 notes · CPU
  6%", with the details on hover. The figure is now right: at light loads it used to read a small
  fraction of the real work, and when the audio engine was overloaded it fell instead of rising.
- It turns yellow when the margin is thin, and red when sound was really lost, with the number of
  dropouts in the text and the milliseconds lost on hover. Until now a dropout was never reported
  at all.
- Playing takes much less of your computer: the arrange view redraws only what is on screen and
  only what changed, and nothing while another view is shown. On a large song the page's own work
  went from more than half a processor core to a tenth of one.

## 0.2.39 (2026-10-04)

- New: open levels straight from Bonsai, a community server for LittleBigPlanet. "From Bonsai" in
  the open dialog searches its LBP2 and LBP3 levels by title, or by a creator's whole name in any
  capitals, reuploads of their levels included, and lists the best matches first. It also opens a
  level from the link or the number of its page there. The song you pick gets a link of its own,
  just like a level from the online archive.
- "Whole backup" on Bonsai also fetches the plans and levels a level depends on, up to sixty, and
  says how many of them did not come.
- Some LBP2 levels that would not open now do: the tracker took a part of theirs for a different
  one. Two music levels on Bonsai that failed now open with all their songs.
- "Play a demo song" is in the open dialog too, and the demo songs now come as a shuffled deck:
  every one plays once before any of them plays again.
- The Ableton Live export with the instruments: every track played 6 dB louder than the game, so
  the master clipped. It now plays at the game's level, each Sampler's filter follows the game
  where a held note spends its time, and its volume takes off what the game's filter takes off
  below its cutoff.

## 0.2.38 (2026-09-25)

- New, and still a work in progress: Import/Export can write the song as an Ableton Live set, which
  Live 11 and later open on its Arrangement. Every part is a MIDI track named after its row and
  instrument, every chip a clip at its own place in the nearest Live colour, and the glides, fades
  and modulation are the notes' own MPE expression. The tempo comes along, each track's volume and
  pan give the same level on each side as the game, and the two sends feed a Reverb and an Echo
  return set from the song.
- "One track per row", on by default, puts every chip of a row and instrument on one track, whose
  mixer changes as each chip comes in.
- "The instruments and their samples", off by default, puts a Live Sampler built from the game's
  own instrument on every track and downloads a zip holding a Live project with the samples: unzip
  it and open the set inside. Each Sampler plays at the modulation most of its track's notes use,
  and the unison layers and the LFOs are not carried yet. A note you add in Live stays silent until
  you give it some pressure in its Note Expression tab.
- The MIDI export: a track holding several parts of one row now changes its volume, pan and sends
  every time a different part takes over. It used to set each part's mixer only once, so a DAW
  played a part that came back after another with the other part's mixer.

## 0.2.37 (2026-09-23)

- The note about crossing 25 rows is a message box now, shown as the 26th row arrives and not
  again until the board has been back at 25 and grows past it once more.

## 0.2.36 (2026-09-23)

- Crossing 25 rows now brings a note in the status bar: the game's own editor stops there, the
  board can go on to 33 with cheats, which the game does not officially support, and past that it
  breaks.

## 0.2.35 (2026-09-22)

- A board may now be 33 rows tall, which is as tall as the game plays one, rather than the 25 its
  own editor stops at.

## 0.2.34 (2026-09-21)

- The sequencer's thermometer moved to where the game has it: a narrow blue column down the left
  side, beside the board and the note panel instead of on top of them. Click it to read how it
  counts.

## 0.2.33 (2026-09-21)

- The sequencer's thermometer is here, at the top right of the board: the game's own blue bar for
  how much sample memory the instruments take, out of the 1 MB it allows, with the megabytes under
  it. Each different sound counts once however often you place it, and notes cost nothing.
- The list that asks which instrument now shows what each one would add to the thermometer, in red
  when it would not fit.

## 0.2.32 (2026-09-21)

- The board now stops where the game's does: 25 rows tall and 500 cells wide. It used to grow to
  64 rows, which no sequencer in the game can have, and had no right edge at all. A song opened
  from a level keeps whatever size it came with.

## 0.2.31 (2026-09-21)

- The bar at the top now shows who made the song, in small print under its name. It is the author
  from Song/Mixer, so it follows what you type there, and a song that names nobody shows only its
  name, as before.

## 0.2.30 (2026-09-21)

- The home page has a "play a demo song" button. It picks one of 25 songs from the community at
  random, fetches its level from the public archive and opens straight on that song. Press it
  again for a different one. The address bar holds the link to the song, so you can share what
  you landed on.

## 0.2.29 (2026-09-21)

- A song sent back into the game now arrives at the size the game makes a music sequencer. An
  exported .plan or .mod used to come out about a third larger than that, and the game could
  refuse to place it, saying it was too big. If that happened to you, export the song again.

## 0.2.28 (2026-09-21)

- The tracker now opens .mod files, the packages Craftworld Toolkit makes. Drop one where you
  would drop a level or a zip: every music sequencer in the plans it holds shows up in the song
  list, named after the path the mod gives it.
- A song can go out as a .mod as well. Import/Export has a "Download .mod" button beside
  "Download .plan": it is the same plan, packed so that Craftworld Toolkit can install it, with
  the song's name as the mod's title and the song's author as its author.

## 0.2.27 (2026-09-14)

- A song sent back into the game now keeps the instrument colours you see on the board. Many
  levels store their instruments as plain white, which the tracker shows in each instrument's own
  category colour; the exported .plan copied the white instead, so the whole board arrived in the
  game white. It now carries the colours the board showed.
- Picking pure white for an instrument now keeps it white. It used to snap back to the
  instrument's own colour, because the game's "no colour" and a white you chose were the same
  number.
- A song now has an author. Opening a level reads who made each sequencer, the way the game keeps
  it (the PSN name of whoever first grouped it), and Song/Mixer shows it in a field you can change.
  It travels in your song file and in a MIDI file exported from here, and an exported .plan
  carries it, so the game's popit says whose it is. A name can hold up to 16 letters, digits,
  hyphens and underscores, the same as a PSN name; anything else is left out as you type.

## 0.2.26 (2026-09-10)

- The note grid now shows what the rest of the row plays around the instrument you are editing:
  one bar before it, and everything after it to the last note on that row. It is drawn faded and
  you cannot touch it, and the bar before is on screen the moment the grid opens, so you can see
  how what you are writing joins what came before and what comes next. Instruments on a row
  overlap in this game, so those notes are almost always inside another chip and there was no way
  to see them while you worked.
- Neither side appears when there is nothing in it, and clicking in them does nothing. Clicking in
  the empty space to the right of a short grid used to drop a note at the end of the grid instead,
  which was never what anyone meant.
- "Find the notes" still looks only at the instrument you are editing, never at the faded parts.
- Clicking the song you already have open, in the song list, now closes the list. It used to be
  the one row in there that did nothing at all, and it never asks about unsaved changes or reloads
  the song: it is a way out of the list, not a way back in.

## 0.2.25 (2026-09-10)

- The note grid stays where you put it. While the song plays, the grid follows the playhead into
  whichever instrument it reaches on the row you are on; clicking an instrument used to hold it
  only until the playhead crossed into the next one, which pulled the grid away from you
  mid-edit, and on another row it could be overridden at once. Now clicking an instrument means
  you want that one, and it stays.
- A "follow" button in the note panel says which of the two is happening and puts it back. Press
  it and the grid jumps to whatever is sounding now and goes back to following; press it again to
  hold where you are without having to click anything. Choosing a row turns following on again as
  well, and so does opening a song.

## 0.2.24 (2026-09-09)

- Instruments keep their colour. Every instrument on the board is drawn in the colour the game
  gives it, which is its category: percussion green, synths sky blue, guitars and strings red,
  tuned percussion blue, wind and voices magenta, pianos yellow, sound effects white. A level you
  open shows the colours it was made with, and the ones a composer changed by hand come through
  as they are.
- You can change a colour yourself. The instrument panel has a swatch under the two sends: pick
  anything, and *reset* puts back the colour that instrument comes with. Nothing about the sound
  changes, and the song does not stop to redraw. The colour travels with the song everywhere it
  goes: your own song file, a MIDI file exported from here and back, and a .plan put into the
  game.
- The song can now go back into LittleBigPlanet. Import/Export has a second button that writes a
  .plan file: the game's own format for a saved object, holding a Music Sequencer with your
  instruments on its board, at your tempo, swing, echo, reverb and mixer settings. Put it into a
  save with a tool that can write one and it is in your popit like anything else you made. Pick
  PS3 or PS4 first, since each game reads only its own; the summary beside the button says what
  went into the file, and the thing to look at is that every dependency is a GUID, which means the
  file needs nothing shipped beside it.
- The object comes out plain: no stickers on it, and the note grids open where a fresh instrument
  would rather than where you left them here. Nothing about the music is left out.
- Shift and drag on the board no longer leaves a green line down the right edge and along the
  bottom. The grids still show a green frame when you reach them with Tab, which is what it was
  always for; a mouse gesture does not put one there any more, and when it does appear it is a
  frame round the whole grid instead of two sides of one.
- Text in a dialog can be copied again. Selecting a song's name or its number in the picker and
  pressing Ctrl+C used to copy the board's instruments instead, and the other keys leaked the same
  way: M muted a row, Delete removed instruments, Space started the song, all while the picker was
  in front of them. Nothing behind an open dialog answers the keyboard now. Outside a dialog,
  Ctrl+C and Ctrl+X copy selected text when there is any, and the instruments when there is not.

## 0.2.23 (2026-09-09)

- Muting or soloing a row while the song plays now holds after you move the playhead back. The
  rows you took out used to come back for the part of the song before the point where you pressed
  the button, and again on every turn of a loop; a note edited inside a playing chip kept its old
  notes there in the same way. All three are fixed together.
- Instruments on the board can now be selected as a block and worked on together: Shift+drag a
  rectangle over them, Ctrl+click to add or remove one, drag any of them to move the whole block,
  Delete to remove it, Ctrl+C, Ctrl+X and Ctrl+V to copy, cut and paste it at the cursor cell, or
  right after the selection, or back where it was cut from, Ctrl+D to duplicate it and Ctrl+A to
  select every instrument. A paste that would land on a taken cell moves right to the first free
  one. A duplicated instrument now lands right after the original instead of one cell on.

## 0.2.22 (2026-09-09)

- Opening a level now says so while it happens, instead of leaving the page looking idle for the
  several seconds it takes. It counts the pieces as they arrive, whether the level comes from a
  link, the archive box, a drop or the file buttons.
- A link can now name a song inside the level, not just the level: the address bar carries the
  song you are looking at, and opening that link again lands straight on it. It is the seq number
  after the level hash. Every song in the picker shows that number beside its name, and typing it
  into the search box finds it; a link with no song in it opens the picker, so the other fifteen
  songs in a level are not hidden behind the biggest one. There is a copy the link button in the
  picker for the songs that have one, which is the levels found online: a level from your own
  machine is not something a link can open. If the browser will not let the page reach the
  clipboard, the link appears in a box to copy by hand.
- Opening a level from the online archive no longer fetches the pieces it depends on unless you
  ask for them. It is faster, and on most levels those pieces are copies of songs the level
  already carries. Tick whole backup, or put &deep=1 in a link, when a song lives only in a piece
  of its own; an adventure still always takes the long route, since it has no world of its own.

## 0.2.21 (2026-09-09)

- A level opened from the online archive now has a link of its own. The address bar carries the
  level's hash once it opens, so copying the URL and sending it to somebody opens the same level
  for them; a link like ?level= followed by the 40 hex digits works on its own too.
- A new song starts at 120 BPM instead of 240.

## 0.2.20 (2026-09-09)

- Switching the song's loop off while it plays no longer fires every remaining note at once. The
  same slip made a pause inside a looped section resume into silence, and moving or clearing a
  chip's loop region while it went round could do either; all three are fixed together.

## 0.2.19 (2026-09-08)

- Sounds with a pan wobble (Ghost, Noise, Synth Strings, Power Guitar, Mosquito, Synth Bell,
  Record Static) sit where the song puts them again. A slip doubled their pan on the way into the
  wobble, which pushed a centred note to the right wall and ran the wobble at twice its speed.
- Stacked sounds that go through the filter (Choir, Brass, Synth Strings, Ghost, Space Piano and
  eight more) are filtered the way the game filters them: once, on the sum of their layers, after
  the game's own clip of that sum. Each layer used to get its own filter before the pan, which is
  not the same thing with this filter.
- Everything the game ramps inside a block is ramped here too instead of stepping every 256
  frames: vibrato, tremolo, the pan wobble, a note's own glides and the modulation swept between
  its control points. Filter sweeps follow per sample as well.
- A layer's pan spread past the edge turns back, as in the game, instead of sticking to the wall.
- Long samples carry the same faint roughness the game gives them: the game reads its sample
  position in single precision, and so does the tracker now.
- A note on a channel whose fader sits at zero takes no voice, as in the game, instead of holding
  one of the 32 and stealing from the others.
- A note written at volume zero that stays there takes no voice and never sounds, as in the
  game; one that opens at zero and rises still fades in.
- With swing on, a glide bends at every step the way the game's does, instead of running straight
  in time across the stretched and squeezed steps.
- The 42 game samples recorded at 44.1 kHz (Ukulele, Record Static and five drum kits) play as
  the game plays them: a frame per frame at 48 kHz, so 8.8% faster and a semitone and a half
  higher than before. The game never reads a sample's own rate; the tracker used to.
- Loops join the way the game joins them: from the loop's last frame straight to its first, with
  the loader's own patch behind the seam. The tracker used to start each loop a frame early,
  which sounded smoother and ran a few cents flat.
- Turning every output switch off no longer drops the level by 4.6 dB.

## 0.2.18 (2026-09-07)

- The Keyboard view plays an instrument's full stack of layers, so sounds that share their samples
  and differ only in how many layers they stack and how far apart those are tuned no longer sound
  the same. Piano and Honkytonk Piano were the pair that gave it away.

## 0.2.17 (2026-09-07)

- The footer on the front page links to the source on GitHub, and to the issue tracker,
  so there is somewhere to say what broke.

## 0.2.16 (2026-09-07)

- The playhead in the note grid glides instead of stepping. It moved ten times a second, which at
  240 BPM is a lurch of a step and a half; it now moves with every frame the screen draws, the way
  the one on the board already did.
- A G beside the volume turns the master bus on and off from the top bar. It is the same switch as
  the one under Song/Mixer, and it lights up while it is on.

## 0.2.15 (2026-09-07)

- A master bus under the engine switches: a compressor and a limiter of this tracker's own,
  after everything the game does, for a mix that holds together. The glue knob says how much of
  it. On a busy song at the default it comes out about 4 dB louder with the peaks still under the
  ceiling, and it is off to begin with, because with it on what you hear is no longer what the
  game would play. The Render view has the same switch, so an exported WAV can carry it.
- Keyboard shortcuts of the kind a DAW has: Space plays and pauses where it is rather than going
  back to the start, Home or Enter return to the start without stopping, End jumps to the end of
  the song, and Ctrl+S saves. On the Arrange view, L turns the loop on and off, and M and S mute
  and solo the selected row.
- The media keys on a keyboard work as well, and so does whatever transport your computer shows
  on screen or on a headset: play, pause, stop, and the skip keys for the start and the end of the
  song. The song's name appears there while it plays.

## 0.2.14 (2026-09-07)

- The rectangle you drag in the note grid now selects points, not whole notes. You can take
  the tail of a glide and leave its head where it is, then move, nudge, delete or change the
  volume of just those points; half a glide copies as half a glide. Clicking a note's line still
  takes the whole note, and dragging any selected point moves everything selected with it.

## 0.2.13 (2026-09-07)

- Every sound now shows the icon the game gives it. The 68 pictures come from the game itself, so
  a chip on the board looks like the one you would have placed in the Music Sequencer.

## 0.2.12 (2026-09-07)

- Notes picked with a rectangle now move together when you drag any one of them by its dot, not
  just by the line between its points. Dragging a single selected note still moves the one point
  you grabbed, so a glide is still shaped the same way: press Esc to drop the selection first.
- The line under the note grid keeps its height when it has nothing to say, so the grid no longer
  jumps by six pixels every time the pointer leaves a note.
- The status line stopped getting stuck on "preparing: voices 0%". Editing one note took a short
  path that never wrote the line back afterwards; it now ends where the full rebuild does, and the
  note count follows the edit.
- "Find the notes" now goes to the view that actually holds the most notes, sideways as well as
  up and down. On a part with a bass line and one high note it used to land halfway between them,
  which is to say on nothing at all.

## 0.2.11 (2026-09-07)

- The reverbs have their real names, in the game's own order: Small Room, Room, Bright Plate,
  Hall, Big Hall and Cathedral. They came out of the game itself, not out of a guess, and the
  list is six rather than five: Small Room is a setting the game offers and no song in the
  corpus of 338 ever picked.

## 0.2.10 (2026-09-07)

- Every sound is called what the game calls it: "Saw Wave", "Beatbox Kit 2", "Electric Guitar
  Power Chords", instead of the file name it used to show ("saw wave", "bb kit 2",
  "e guitar power"). The names come from the game's own palette items and its own translations, so
  all 68 are named and none is invented.
- The sound picker shows the game's category beside each name, Keys or Plucked or Percussion, and
  searching now matches the category as well. Typing in lower case finds them again: with the
  names capitalised it would have stopped matching.

## 0.2.9 (2026-09-07)

- Reverb is a menu now, not a slider, and it lists the five settings the game actually writes: over
  338 sequencers from real levels the value is only ever 1 to 5, while the slider went to 15. Each
  option says how long that reverb rings, and hovering it gives the delay before the tail, the
  damping and the levels.
- A new song starts on reverb 5, the setting three out of five real sequencers use. It used to
  start on 0, which no sequencer in the corpus holds and which is not "no reverb" either.

## 0.2.8 (2026-09-07)

- The rectangle you drag round notes now catches a held note whose line crosses it, not only notes
  with a point inside it, and the line under the grid counts what it has caught as you drag. Hold
  Ctrl while dragging it to add to the selection instead of replacing it.
- New keys for a selection of notes: Ctrl+X cuts, Ctrl+D duplicates it one step further on and
  selects the copy, so pressing it again walks on down the grid. Pasting with nothing selected
  puts the notes back where they were cut from.
- The line under the grid says how many notes are selected and which keys act on them, so the
  commands are not only in the help.

## 0.2.7 (2026-09-07)

- The song's end marker can be dragged on a new song again. Since 0.2.6 it was drawn there but did
  not answer the pointer. Dragging it right up to the start now leaves it one tile in, instead of
  taking it away with no way to take hold of it again.

## 0.2.6 (2026-09-07)

- In the note grid the line between a note's points now shows what it does between them: it
  swells where the volume rises and thins where it falls, and its colour runs from one point's
  timbre to the next. The dots still say what each point is; the line now says what happens on
  the way.
- A new song starts with an end marker two tiles along the board, so there is a length to lay a
  song out against, and something to drag, before the first instrument is placed. It used to
  appear only once a chip was there.
- Closing the tab or the window with unsaved changes asks first on every browser; Safari and the
  older ones were closing without a word.

## 0.2.5 (2026-09-07)

- The site installs as an app: on a phone or a desktop the browser offers to add it, and it then
  opens in its own window, with its own icon, and starts without a network.
- A link to the site now unfurls with a title, a description and the icon, and search engines are
  told what the site is.

## 0.2.4 (2026-09-07)

- With the note panel open, the board's horizontal scrollbar sits just above it instead of under it.

## 0.2.3 (2026-09-07)

- The board zooms in time: "-" and "+" in the corner cell between the row numbers and the bar
  numbers make the bars narrower or wider, the glass between them puts them back, and the rows
  keep their height. The choice is remembered.

## 0.2.2 (2026-09-07)

- On the published site the top bar sat 20 px down over the bar numbers, the status bar was
  taller than meant and the views were capped in width: the page's own styles were losing to
  the shared ones there, and only there. Fixed.

## 0.2.1 (2026-09-07)

- The board and the note grid follow the playhead only until you scroll away from it, ahead or
  behind; scrolling back to it, seeking, or pressing play makes them follow again.
- Removing a row with instruments on it, and throwing away unsaved changes, ask through the
  app's own dialog rather than the browser's.

## 0.2.0 (2026-09-07)

### One page, one song
- The five pages are one app: Arrange, Song/Mixer, Render, Import/Export and Keyboard are views
  on the same song, and switching between them never stops the music.
- A top bar with the views, the transport (play, stop, loop), the clock, the tempo, the volume
  under a stereo VU meter, the song's name, and new, open and save. Space plays from any view, and
  the loop goes round without a gap.
- A status bar at the bottom: what is going on, the notes sounding, the audio load and any
  dropouts, and the version, which opens this list.
- A home page behind the brand, with the app presented in a few lines; the site opens on it, and
  reading it does not lose the song.
- "Open" is a dialog: a level of your own, a save backup, a zip, a song file or a level from the
  public archive, dropped or picked, with a searchable list of the songs when a level holds several.
- A song file (.json) saves the song as it is here and opens again anywhere a level would.
- A "?" beside every card opens the help for it; the views themselves carry little prose.
- An icon of its own for each of the 68 sounds, on the chips, in the picker and in the sound fields.
- A favicon: the note from the logo, in its square.

### Arrange, new
- The board as the game lays it out: a row per line, a chip per instrument, as long as its note
  grid, four bars to a tile. Drag over empty cells to draw a chip and pick its instrument; drag a
  chip to move it, duplicate or remove it, and the bar numbers and row numbers stay put as you
  scroll.
- Rows select; the note grid follows the chip the playhead is inside on the selected row.
- Mute and solo on every row; a white line between the mixer channels; the end of the song shown,
  respected by the playhead, and draggable to make room past the last chip.
- A "+" under the last row adds one; the selected row's number turns into an "x" to remove it,
  asking first when it holds instruments. Chips and row numbers light up as their notes start.
- The note grid in a panel that rises over the board, resizable by its top edge: notes as chains
  of points joined by lines, the size of a point its volume and its colour its timbre, a note
  ending at its last point. Triplet grid at three cells to the beat, with the other grid's notes
  drawn faded. Undo and redo, copy and paste, a selection box, the arrow keys to nudge, and a
  keyboard on the left to try the instrument.
- Editing inside a chip, drawing one, removing one or muting a row while the song plays is heard at
  once, without a stutter: only that chip is re-planned, and nothing already on its way to the
  speakers is played twice.
- "Loop this chip" in the note panel cuts the song off and goes round the chip's bars with every
  other row at a fifth of its volume, to work on one part in place; pressing it again leaves the
  song at the chip's start, playing on from there if it was playing before.
- The chip's own settings beside the grid: its length in bars (four, then two at a time), key and
  scale, level, pan, and its sends to the echo and the reverb; and the selected point's pitch,
  volume and timbre as sliders.

### Song/Mixer
- The song's name, tempo, swing and loop; the channels and their faders, with how many chips each
  carries; the board's rows; the echo and the reverb: every field the game keeps, in one card.
  Tempo and swing change while the song plays without losing your place.
- The engine's own switches and meters in a card of their own: the voice pool, the echo, reverb
  and output clip switches, and what the audio thread is doing.

### Render
- Renders the song as it is, mutes and solos included, and lays the summary out as cards.

### Import/Export
- Renamed from Converter. Exports the open song; an imported MIDI file becomes the song, with an
  instrument picked for each part.

### Keyboard
- Follows the chip selected on the board, and opens with the piano already loaded; the sound is
  picked from the same searchable list as on the board. The first card is two groups: the
  instrument, and the MIDI controller.

## 0.1.0 (2026-09-06)

The first release.
