/**
 * The help behind every "?" on the page: one dialog, one topic at a time.
 *
 * Written for the person using the app, not for the person building it: what a
 * control does and what to expect of it, never how it is implemented or where
 * a number was measured -- that belongs to `steering/`, which the site does not
 * ship. The views themselves carry as little prose as they can; a "?" beside a
 * card's title opens the topic for that card.
 *
 * A button opts in with `data-help="<topic>"`. The click is caught on the
 * document, so a button drawn later by Vue needs no wiring of its own.
 */

import changelog from '../../../CHANGELOG.md?raw';

export type HelpTopic =
  | 'changelog'
  | 'app'
  | 'open'
  | 'board'
  | 'thermometer'
  | 'notes'
  | 'song'
  | 'engine'
  | 'render'
  | 'export'
  | 'als'
  | 'plan'
  | 'import'
  | 'keyboard'
  | 'terms'
  | 'privacy'
  | 'cookies';

interface Topic {
  readonly title: string;
  /** Paragraphs and sub-headings; trusted markup written here, never user text. */
  readonly body: string;
}

const p = (html: string) => `<p>${html}</p>`;
const h = (text: string) => `<h4>${text}</h4>`;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The changelog, from the repository's own CHANGELOG.md: headings, bullets and
 * paragraphs are all it uses, so that is all this reads. The first heading is
 * the file's title and the note under it is for the file's editors; both stop
 * at the first version heading.
 */
function changelogHtml(md: string): string {
  const lines = md.split('\n');
  const from = lines.findIndex((l) => l.startsWith('## '));
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((i) => `<li>${i}</li>`).join('')}</ul>`);
    if (para.length) out.push(p(para.join(' ')));
    list = [];
    para = [];
  };
  for (const raw of lines.slice(from < 0 ? 0 : from)) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) { flush(); out.push(`<h3>${escape(line.slice(3))}</h3>`); }
    else if (line.startsWith('### ')) { flush(); out.push(h(escape(line.slice(4)))); }
    else if (line.startsWith('- ')) { if (para.length) flush(); list.push(escape(line.slice(2))); }
    else if (line.startsWith('  ') && list.length) list[list.length - 1] += ' ' + escape(line.trim());
    else if (line === '') flush();
    else para.push(escape(line));
  }
  flush();
  return out.join('');
}

export const HELP: Readonly<Record<HelpTopic, Topic>> = {
  changelog: {
    title: 'What changed',
    body: changelogHtml(changelog),
  },
  app: {
    title: 'Getting around',
    body:
      p('One song is open at a time and every view works on it: <strong>Arrange</strong> to write it, ' +
        '<strong>Song/Mixer</strong> for its tempo, channels and effects, <strong>Render</strong> to make a WAV, ' +
        '<strong>Import/Export</strong> for MIDI files, <strong>Keyboard</strong> to play the instruments by hand. ' +
        'Switching views never stops the music; the brand in the corner opens the home page over the song.') +
      h('Transport') +
      p('Play and stop are in the top bar; stop also goes back to the start, and the loop button starts the song ' +
        'over when it ends. <kbd>Space</kbd> plays and pauses from any view. The clock shows where you are and how ' +
        'long the song is, the BPM box changes the tempo as it plays, the fader sets the volume, and the two bars ' +
        'above it are the left and right output levels. The status bar at the bottom says how many notes are ' +
        'sounding, how busy the audio is, and whether it has dropped out.') +
      p('The keys a transport usually answers to, from any view: <kbd>Space</kbd> plays and pauses where it is, ' +
        '<kbd>Home</kbd> or <kbd>Enter</kbd> go back to the start without stopping, <kbd>End</kbd> jumps to the ' +
        'end of the song, and <kbd>Ctrl+S</kbd> saves it. On the Arrange view, <kbd>L</kbd> turns the loop on ' +
        'and off and <kbd>M</kbd> and <kbd>S</kbd> mute and solo the row you have selected. Those three are ' +
        'letters, so they wait for that view: on the Keyboard view the same letters play notes.') +
      p('The keyboard’s <strong>media keys</strong> work too, and so does whatever transport your computer puts ' +
        'on screen or on a headset: play, pause, stop, and the skip keys, which go to the start and the end of the ' +
        'song. The song’s name shows there while it plays.') +
      h('Files') +
      p('<strong>open</strong> takes a level, a backup, a zip or a song file, and its <em>new song</em> starts an empty one; ' +
        '<strong>save</strong> writes the song as a file this site can open again. A dot before the name means ' +
        'there are unsaved changes; the name itself is set under Song/Mixer. Nothing you open leaves your computer.'),
  },
  open: {
    title: 'Opening something',
    body:
      p('Drop a file on the box or use its buttons. It can be a level of your own, a save backup, a zip holding ' +
        'either, or a song file saved here. <strong>From the online archive</strong> opens a level published before ' +
        'the official servers closed, by the hash on its page at zaprit.fish. <strong>From Bonsai</strong> searches ' +
        'the levels published on Bonsai, a community server, by title or by a creator’s whole name, best match ' +
        'first, or opens one by its link or number. Either way the level comes straight to your browser, and the ' +
        'address bar becomes a link to the song you pick. <strong>Play a demo song</strong> opens one of the ' +
        'community songs picked for this site; each plays once before any plays again.') +
      p('A level holding several songs lists them below the box: pick one and it becomes the song. ' +
        'Whatever is open is replaced, so save first if it matters.'),
  },
  thermometer: {
    title: 'The thermometer',
    body:
      p('The blue bar down the left side is the game\'s own thermometer for a sequencer: how much sample memory its ' +
        'instruments take, out of the 1 MB the game allows, with the same in megabytes under it. ' +
        '<strong>Each different sound costs its samples once</strong>, however many times it is placed, sounds that ' +
        'share samples pay for them once between them, and notes are free. The list that asks which instrument ' +
        'shows what each one would add, in red when it would not fit. Past 100% the bar turns red: the tracker still ' +
        'plays the song, but the game would say there are too many instruments on the sequencer.'),
  },
  board: {
    title: 'The board',
    body:
      p('Every row is one line of the arrangement and every rectangle is an instrument playing there, ' +
        'as long as its note grid. One row is selected at a time: click its number, an instrument on it, ' +
        'or an empty cell. As the song plays, the note panel follows the instrument the playhead is inside on that row.') +
      h('Placing instruments') +
      p('<strong>Drag across empty cells</strong> to draw a new instrument as long as the drag, four bars at least ' +
        'and then two at a time; pick which instrument when you let go. A double-click draws a four-bar one. ' +
        'Click an instrument to open its notes and drag it to another cell. Instruments may overlap in time, ' +
        'though the game\'s composers rarely let them.') +
      h('Selecting, moving and copying') +
      p('<strong>Shift+drag</strong> a rectangle to select every instrument it touches; <kbd>Ctrl</kbd> with it ' +
        'adds to the selection, and <kbd>Ctrl</kbd>+click or <kbd>Shift</kbd>+click puts one instrument in or out. ' +
        'Drag any instrument of the selection and the whole block moves with it, staying on the board. ' +
        '<kbd>Delete</kbd> removes the selection, <kbd>Ctrl+C</kbd> and <kbd>Ctrl+X</kbd> copy and cut it, ' +
        '<kbd>Ctrl+V</kbd> pastes it at the cursor cell, or right after the selection when there is no cursor, ' +
        'or back where it was cut from; <kbd>Ctrl+D</kbd> duplicates it the same way, and <kbd>Ctrl+A</kbd> ' +
        'selects every instrument. A paste that would land on a taken cell moves right to the first free one, ' +
        'and the board grows to hold rows pasted below its last. These keys reach the board when it has the ' +
        'focus or the note panel is closed; otherwise they work on the notes in the panel.') +
      h('The thermometer') +
      p('The blue bar down the left side is the game\'s budget of sample memory for one sequencer. ' +
        'Click it to read how it counts.') +
      h('Rows, channels and the end') +
      p('The game\'s own editor stops a board at 25 rows. Here it can grow to 33, which the game plays only ' +
        'with cheats and does not officially support; past that it breaks. A message says so when you cross 25, ' +
        'once, until the board is back at 25 and crosses it again.') +
      p('The corner cell between the row numbers and the bar numbers zooms the board in time: ' +
        '<strong>-</strong> and <strong>+</strong> make the bars narrower or wider, the glass puts them back; the rows keep ' +
        'their height.') +
      p('The <strong>+</strong> under the last row adds one. To remove a row, select it and click its number, which ' +
        'turns into an <strong>&times;</strong> under the pointer; a row that holds instruments asks first. ' +
        'The <strong>M</strong> and <strong>S</strong> boxes beside a row mute it or solo it. When the song has more ' +
        'than one mixer channel a white line divides the rows into channels, top to bottom. Click the bar numbers to ' +
        'jump there; drag the dashed line at the end of the song to make room past the last instrument.') +
      p('<strong>Drag along the bar numbers</strong> to mark a loop region: the song goes round those bars while it ' +
        'plays. Click the region\'s band to remove it; clicking the bar numbers outside it ends the loop and jumps ' +
        'there. It is only for listening, so it is not saved with the song and the game never sees it; ' +
        '<em>Loop this chip</em> takes over from it while it is on.'),
  },
  notes: {
    title: 'The notes',
    body:
      p('The panel shows the selected instrument\'s note grid. <strong>Click</strong> to place a note, ' +
        '<strong>drag</strong> to give it an end: sideways for a held note, diagonally for a glide. A note is a chain ' +
        'of points and the sound slides from one to the next.') +
      h('Points') +
      p('The size of a point is its volume, its colour its timbre, from blue to orange. Drag a point to move it; ' +
        '<kbd>Shift</kbd>+drag up or down changes its volume, <kbd>Alt</kbd>+drag its timbre. Double-click a line to ' +
        'add a point, double-click a point to remove it; right-click removes a point or, on the line, the whole note. ' +
        'The point card on the right edits the selected point with sliders.') +
      h('Selection and keys') +
      p('<kbd>Shift</kbd>+drag on empty space draws a rectangle, and what it catches is the <strong>points</strong> ' +

        'inside it, not whole notes: you can take the tail of a glide and leave its head where it is. The line ' +

        'under the grid counts them as you drag. Hold <kbd>Ctrl</kbd> as well and the rectangle adds to what is ' +

        'already selected, and <kbd>Ctrl</kbd>+click puts one point in or takes it out. Clicking the line of a note ' +

        'takes the whole note, every point of it, and dragging any selected point moves the whole selection.') +

      p('Arrow keys nudge the selected points a cell sideways or a semitone up and down, with <kbd>Shift</kbd> ' +

        'a whole octave; <kbd>+</kbd>/<kbd>-</kbd> change their volume and <kbd>[</kbd>/<kbd>]</kbd> their timbre. ' +

        '<kbd>Delete</kbd> removes them, and a note whose last point goes with them goes too. ' +

        '<kbd>Ctrl+D</kbd> duplicates one step further on, <kbd>Ctrl+X</kbd>/<kbd>C</kbd>/<kbd>V</kbd> cut, copy ' +

        'and paste (half a glide copies as half a glide), <kbd>Ctrl+A</kbd> takes every point in the chip and ' +

        '<kbd>Ctrl+Z</kbd>/<kbd>Y</kbd> undo and redo. With something copied, a translucent preview follows the pointer over the grid and Ctrl+V puts it down there. ' +

        'Holding <kbd>Shift</kbd> keeps the preview at the pitch it was copied at, <kbd>Alt</kbd> at its time. ' +

        'With the pointer elsewhere a paste lands at the playhead when it is inside the chip, otherwise a step after the selection, or back where it was cut from when nothing is selected.') +

      p('The bar above the grid picks the tool: <strong>draw</strong> (<kbd>D</kbd>), <strong>select</strong> (<kbd>V</kbd>), which ' +
        'drags a rectangle on empty grid, and <strong>erase</strong> (<kbd>E</kbd>), which removes what the pointer crosses. ' +
        '<kbd>Ctrl</kbd>+wheel zooms the time and <kbd>Alt</kbd>+wheel the pitch, each with its own pair of buttons, and ' +
        '<kbd>Ctrl+0</kbd> goes back to the normal size. ' +
        'When the instrument has a scale, the rows it uses are ' +
        'lit and the others darkened: a note on a dark row plays as the scale tone it is snapped to, and the line under the grid says which. Dragging shows the note and position ' +
        'beside the pointer, sounds each pitch it reaches, and leaves the points\' old place faintly drawn.') +

      p('<kbd>T</kbd> switches to the triplet grid, three cells to the beat instead of four. ' +
        'Notes on the other grid are drawn faded, and so are the row&rsquo;s other chips around the open instrument. ' +
        'The keyboard on the left plays the instrument.') +
      h('The instrument') +
      p('<strong>grid</strong> is how long the instrument is, in bars. <strong>key</strong> and <strong>scale</strong> ' +
        'transpose and fold its notes the way the game does. <strong>level</strong> and <strong>pan</strong> are its own ' +
        'volume and position; the two <strong>sends</strong> say how much of it goes to the song\'s echo and reverb. ' +
        '<strong>colour</strong> is the chip\'s own on the board, the way the game keeps it: a new chip takes the ' +
        'colour its instrument comes with in the popit, <em>reset</em> puts it back, and it travels in a MIDI ' +
        'file and in an exported plan. Nothing plays it. ' +
        'Around the instrument the grid shows what the rest of the row plays, faded: the instrument before it, and ' +
        'the one after it. That is how you see the join with what came before and what comes next, since ' +
        'instruments on a row overlap. Nothing in the faded parts can be clicked or moved, and ' +
        '<em>find the notes</em> ignores them. ' +
        '<strong>Follow</strong> is whether the grid moves to whichever instrument the playhead is inside on ' +
        'this row. Clicking an instrument turns it off, so what you are looking at stays put while the song ' +
        'plays; the button puts it back and jumps to the one sounding now, and choosing a row turns it on too. ' +
        '<strong>Loop this chip</strong> cuts the song off and goes round the chip\'s bars with every other row at a ' +
        'fifth of its volume, to hear the part in place while you edit it. It follows the chip you select; pressing ' +
        'it again leaves the song at the chip\'s start, playing on from there if it was playing before, and stop, ' +
        'or closing the panel, ends it too. ' +
        'Drag the panel\'s top edge to resize it; <kbd>Esc</kbd> closes it.'),
  },
  song: {
    title: 'The song',
    body:
      p('The <strong>name</strong> is what the song is saved as, and what a level calls it. ' +
        'The <strong>author</strong> is who made it, as the game keeps it: the PSN name of whoever first grouped it, ' +
        'read out of the level, and written back into an exported plan so the popit says whose it is. ' +
        '<strong>Tempo</strong> and <strong>swing</strong> take effect at once, while it plays, and keep your place in the music. ' +
        '<strong>Loop</strong> starts the song over when it ends, here and in the game; the top bar has the same switch.') +
      h('Channels') +
      p('The board is cut into as many bands as there are channels, top to bottom, and each band has its own fader. ' +
        'The number beside a fader is how many instruments sit on that channel. <strong>Board rows</strong> is how many ' +
        'rows the board has.') +
      h('Echo and reverb') +
      p('The echo\'s <strong>time</strong> is in beats, so it follows the tempo; <strong>feedback</strong> is how long it ' +
        'repeats and <strong>mix</strong> how loud. Each instrument sends its own amount to both, in its note ' +
        'panel.') +
      p('<strong>Reverb</strong> is the list of six the game itself offers, in its own order: Small Room, Room, ' +
        'Bright Plate, Hall, Big Hall and Cathedral. Each picks a whole preset, so the option also says how long ' +
        'that one rings, and hovering it gives the delay before the tail, the damping and the levels. Big Hall ' +
        'rings longest; Cathedral is the largest space, with the longest delay before its tail arrives.'),
  },
  engine: {
    title: 'The engine',
    body:
      p('These switches are not part of the song; they change how it is played here.') +
      p('The game plays at most <strong>32 notes at once</strong> and cuts the oldest when more arrive, which is part ' +
        'of how a busy song sounds. A smaller pool cuts more, and <strong>unlimited</strong> plays every note, which no ' +
        'longer sounds like the game. Changing it while the song plays takes effect at once.') +
      p('<strong>echo</strong>, <strong>reverb</strong> and <strong>output clip</strong> switch those parts of the sound ' +
        'off to hear the song without them. Below them: how many notes are sounding, how many times the audio could ' +
        'not keep up, and how many notes the pool has cut so far.') +
      p('The <strong>master bus</strong> is the last thing the sound goes through, and there are four. ' +
        '<strong>The game’s</strong> is what the game itself does after the reverb: the compressor it ends every ' +
        'song with, which brings the loudest moments down, and the way a television folds the game’s surround ' +
        'sound into two speakers, which also pulls every instrument a little towards the middle, so nothing is ' +
        'ever panned hard to one side. It is quiet: the game plays its songs well below full volume.') +
      p('<strong>The game’s + AGC</strong> is the same sound with a slow automatic volume ' +
        'after it, which turns a song up or down towards a comfortable level as it plays, the way you would ' +
        'ride the volume yourself, and stops anything going over the top. It settles on a song within its ' +
        'first seconds and then moves slowly, over tens of seconds, so a song keeps most of its quiet and loud ' +
        'parts; one that starts very quietly and gets loud is evened out a little. The line below the switches ' +
        'says how far it is turning the sound up.') +
      p('<strong>none</strong> skips the compressor and the folding and keeps only the folding’s volume: what ' +
        'this tracker played before it had the game’s. <strong>Ours</strong>, where it starts, is the one thing ' +
        'here that is not the game: a compressor and a limiter of this tracker’s own, which even the loud parts ' +
        'out against the quiet ones and stop anything going over the top, the way a mix is usually finished, and ' +
        'keep each instrument’s pan as the song wrote it. <strong>glue</strong> is how much of it. With ours, ' +
        'what you hear is no longer what the game would play.'),
  },
  render: {
    title: 'Rendering',
    body:
      p('<strong>Render</strong> writes the whole song, or just a section, to a WAV file at studio quality, through ' +
        'the same engine you hear live. Tick <strong>just a section</strong> and give it a start and an end as ' +
        'minutes:seconds. The switches beside it are the same as the engine\'s: the size of the voice pool, ' +
        'whether the echo, the reverb and the output clip are in, and which master bus ends it: ours at its ' +
        'usual glue, the game’s with its automatic volume, the game’s at its own volume, or none.') +
      p('When it is done the waveform appears: click it to seek, <kbd>Space</kbd> plays, the arrow keys scrub. ' +
        '<strong>Download WAV</strong> saves it, and the cards below say what the render contained.'),
  },
  export: {
    title: 'Exporting a MIDI file',
    body:
      p('<strong>Download .mid</strong> writes the song as a MIDI file any DAW opens, one track per board row ' +
        'and instrument, named after both.') +
      h('The options') +
      p('<strong>MPE</strong> gives every note its own channel, so a glide stays with its note; ' +
        '<strong>plain</strong> gives every instrument one channel, which older software prefers. ' +
        '<strong>Split into several files</strong> when one is not enough. <strong>Bake the swing</strong> writes the ' +
        'swung timing into the notes rather than leaving it to the player. <strong>Carry what MIDI cannot say</strong> ' +
        'stores the rest of the song inside the file, so a file that comes back here is the same song; other ' +
        'programs simply ignore it. The <strong>bend range</strong> is how far a glide can reach; picked from the ' +
        'music, it is always enough.') +
      h('What cannot be carried') +
      p('A very dense passage runs out of MPE channels: notes that have to share one lose their own glide, and the ' +
        'tally says how many. Key and scale are folded into the notes, so an import comes back chromatic, sounding the same.'),
  },
  als: {
    title: 'Exporting an Ableton Live set',
    body:
      p('<strong>Download .als</strong> writes the song as a Live set that Live 11 and later open, on its ' +
        'Arrangement. Every part is a MIDI track named after its row and instrument, and every chip on the board ' +
        'is a clip at the same place on the timeline and as long as the chip, empty bars included, in the Live ' +
        'colour nearest the chip’s own.') +
      p('Glides, fades and the modulation are the notes’ own MPE expression, exactly as the song draws them: ' +
        'open a clip and look at its Note Expression tab. The tempo is the song’s, and each track’s volume and ' +
        'pan are set so that Live puts the same level on each side as the game does. The two sends feed the ' +
        'returns: <strong>Reverb</strong>, Live’s Reverb set to the song’s room, and <strong>Echo</strong>, ' +
        'Live’s Delay at the song’s echo time and feedback, feeding the reverb as the game’s echo does.') +
      p('The swing is a groove, <strong>LBP swing</strong> and the song’s number, that every clip follows: the ' +
        'notes stay on Live’s grid, and Live swings them as it plays. Open the Groove Pool to turn it up, down ' +
        'or off. <strong>Bake the swing</strong> writes the swung timing into the notes instead, with no ' +
        'groove: that is exactly the game’s timing, and it puts the notes off Live’s grid.') +
      p('<strong>One track per row</strong> puts every chip of one row and instrument on a single track, so ' +
        'there is one instrument to load per row. Where those chips differ in volume, pan or a send, the track ' +
        'carries it as mixer automation that changes as each one comes in. Chips that play at the same time ' +
        'stay on tracks of their own. Off, every different mixer setting is a track.') +
      h('The instruments') +
      p('Off, the tracks are empty: load an instrument on each, one that answers MPE if you want the glides. ' +
        '<strong>The instruments and their samples</strong> puts a Live Sampler on every track instead, built ' +
        'from the game’s own instrument: its samples on the same keys, their loops, the volume and filter ' +
        'envelopes, the filter and the level. The download is then a zip holding a Live project; unzip it and ' +
        'open the set inside, and Live finds the samples beside it. The samples are the game’s, which is why ' +
        'this is off unless you ask.') +
      p('A Sampler is set at one modulation per track, the one most of its notes use, because a Live Sampler ' +
        'cannot move as many things per note as the game’s instruments do. What the modulation does to a note’s ' +
        'level and filter cutoff still follows it, on the note’s pressure and slide, so a swell or a filter sweep ' +
        'comes through; its envelopes and resonance stay the track’s, and the tally counts the notes that differ. ' +
        'The unison layers and the three LFOs are not carried.') +
      p('Each note’s volume, fades included, is its pressure, which the Sampler’s MIDI tab turns into level. ' +
        'So a note you add in Live stays silent until you draw it some pressure in the Note Expression tab, ' +
        'or turn the Pressure amount down in the Sampler’s MIDI tab.') +
      p('<strong>Our master bus on the master</strong> puts the tracker’s own master bus on Live’s master ' +
        'track: Live’s Compressor set as the glue, then Live’s Limiter, at the glue the Song/Mixer card is set ' +
        'to. Like the tracker’s, it is ours and not the game’s, and off unless you ask for it. With it the set ' +
        'plays about as loud as the tracker does with our master bus; without it, Live’s master hears the song ' +
        'as it reaches the game’s master bus, before the game’s compressor and before the fold that raises it.') +
      h('What is not in it') +
      p('The reverb and the echo are Live’s own, set as close as they go to the game’s, not the game’s ' +
        'themselves. The swing groove moves a note that starts on an off-beat to where the game plays it; ' +
        'what Live does with a note’s end, or with a note between two sixteenths, has not been checked, ' +
        'so bake the swing when the timing has to be the game’s.') +
      p('A glide wider than 48 semitones stops at 48, which is as far as Live goes, and the tally says when ' +
        'that happens.'),
  },
  plan: {
    title: 'Sending the song back to LittleBigPlanet',
    body:
      p('<strong>Download .plan</strong> writes the song as the file the game itself uses for a saved object: ' +
        'a Music Sequencer with your chips on its board, the tempo, the swing, the echo, the reverb and the ' +
        'mixer, ready to drop into a level.') +
      h('Which build') +
      p('LBP3 on PS3 and on PS4 write the same file with one number different, and each game reads only its ' +
        'own. Pick the one the save is going into. PS3 is also the right answer for RPCS3.') +
      h('What the summary says') +
      p('<strong>Dependencies</strong> are the things the plan points at — the gadget’s mesh, and one ' +
        'instrument and one icon per chip. They are all <em>GUIDs</em>, meaning assets already in the game, so ' +
        'the file needs nothing shipped beside it. A hashed dependency would be somebody’s own resource and ' +
        'would have to travel with it; this export never writes one.') +
      h('Getting it into the game') +
      p('A .plan is not something the game opens by itself: it goes into a save with a tool that can write ' +
        'one — ennuo’s Craftworld Toolkit is the usual one — and then it is in your popit like anything else. ' +
        'The object comes out plain: no stickers on it, and the note grids open where you left them here.'),
  },
  import: {
    title: 'Importing a MIDI file',
    body:
      p('Drop any MIDI file on the box. A file that was exported from here brings its instruments with it; ' +
        'one from a DAW has none, so pick what each part should sound like, then <strong>make it the song</strong>. ' +
        'That replaces whatever is open, so save first if it matters.'),
  },
  keyboard: {
    title: 'The keyboard',
    body:
      p('Play the game\'s instruments by hand. The instrument follows the one selected on the board, or pick any. ' +
        'Click the keys, or use the computer keyboard: <kbd>Z S X D C V G B H N J M</kbd> is one octave with its ' +
        'sharps, <kbd>Q 2 W 3 E R 5 T 6 Y 7 U</kbd> the octave above, <kbd>&larr;</kbd> <kbd>&rarr;</kbd> shift the ' +
        'octave, <kbd>Esc</kbd> silences everything. A note lasts as long as the key is down, and the keys play only ' +
        'while this view is open.') +
      h('A MIDI controller') +
      p('Pick it under <strong>MIDI in</strong>; the browser asks once for permission. An MPE controller is recognised ' +
        'on its own, and <strong>MPE</strong> can force a zone or switch it off; <strong>bend range</strong> is how far ' +
        'the wheel reaches. Pressure and slide can each be turned off.') +
      h('Turning things') +
      p('The faders change the sound while it plays. A group with an <strong>override</strong> box uses your values ' +
        'only while it is ticked; unticked, the instrument plays as the game made it. Double-click any fader to put ' +
        'it back where it started.') +
      h('The bench') +
      p('Three buttons play set sequences: every sample of the instrument at its own note, a scale, and a chromatic ' +
        'run. <strong>Note length</strong> is how long those hold each note. The engine and sampler choices play the ' +
        'same thing through different resamplers, to compare them by ear.'),
  },
  terms: {
    title: 'Terms of service',
    body:
      p('<em>Last updated 30 October 2026.</em>') +
      p('These terms cover your use of LBP Tracker, the website at lbptracker.sgdc3.it, run by sgdc3 (&ldquo;I&rdquo;). ' +
        'By using the site you agree to them. If you do not, please do not use it.') +
      h('What this is') +
      p('LBP Tracker is a free, open-source editor and player for the music sequencer of LittleBigPlanet&nbsp;3. ' +
        'It runs in your browser. It is a fan project, with no connection to Sony Interactive Entertainment or ' +
        'Media Molecule, and not endorsed by either. LittleBigPlanet is a trademark of Sony Interactive Entertainment.') +
      h('Your files and your work') +
      p('Songs, levels and backups you open stay on your computer; the site does not receive them. ' +
        'You keep whatever rights you have in what you make. You are responsible for having the right to use the files ' +
        'you open, and for what you do with the songs, WAV files, MIDI files and plans you export. Levels from the ' +
        'online archive and from Bonsai are their creators&rsquo; work: they are fetched for you to listen to and edit ' +
        'on your own machine, not republished by this site.') +
      h('Game material') +
      p('The instrument sounds and the instrument pictures come from the game and belong to their rights holders. ' +
        'They are here so a song can be heard as the game plays it, and for no other purpose. They are not covered by ' +
        'the software licence, and you may not use them outside this site in ways the rights holders have not allowed. ' +
        'If you hold rights in something shown here and want it changed or removed, tell me (see Contact) and I will look at it promptly.') +
      h('The software licence') +
      p('The source code is published under the MIT licence, which applies to the code only and is in the project&rsquo;s ' +
        'repository. These terms are about using the website, not about the code you may copy.') +
      h('Use it fairly') +
      p('Do not use the site to break the law, to attack it or other people&rsquo;s systems, or to put an unreasonable ' +
        'load on it with automated requests. I may change or remove features, or block abuse, at any time.') +
      h('No warranty') +
      p('The site is provided &ldquo;as is&rdquo;, free of charge, with no promise that it is correct, always available, ' +
        'or fit for any purpose. It aims to reproduce the game&rsquo;s sequencer faithfully but may differ from it, and ' +
        'a plan exported from here may not behave in the game as expected. Keep your own backups: a song that is not ' +
        'saved is lost when the page closes.') +
      h('Limit of liability') +
      p('As far as the law allows, I am not liable for any loss or damage arising from your use of the site, including ' +
        'lost work or a level damaged by importing an exported plan. Nothing here limits liability that cannot be ' +
        'limited by law, including your rights as a consumer where they apply.') +
      h('Changes and law') +
      p('I may update these terms; the date above says when. Using the site after a change means you accept it. ' +
        'The terms are governed by Italian law, without removing any protection that mandatory law of your own country gives you.') +
      h('Contact') +
      p('Use the contact details on <a href="https://sgdc3.it" target="_blank" rel="noreferrer noopener">sgdc3.it</a>, or the <a href="https://github.com/LBPTracker/lbptracker/issues" target="_blank" rel="noreferrer noopener">issues page</a> of the project.'),
  },
  privacy: {
    title: 'Privacy policy',
    body:
      p('<em>Last updated 30 October 2026.</em>') +
      p('The short version: <strong>the site does not collect your personal data.</strong> It has no accounts, no ' +
        'analytics, no advertising and no tracking, and the songs and levels you open are not uploaded.') +
      h('Who is responsible') +
      p('sgdc3, an individual, runs lbptracker.sgdc3.it. Contact: the contact details on <a href="https://sgdc3.it" target="_blank" rel="noreferrer noopener">sgdc3.it</a>, or the <a href="https://github.com/LBPTracker/lbptracker/issues" target="_blank" rel="noreferrer noopener">issues page</a> of the project.') +
      h('What stays on your computer') +
      p('Everything you open or make is processed inside your browser. The site keeps a few settings in your browser&rsquo;s ' +
        'own storage so they survive a reload: the height of the note panel, the board zoom and whether the metronome is on. ' +
        'They never leave your device. The <a role="button" tabindex="0" data-help="cookies">cookie policy</a> lists them.') +
      h('What the hosting provider sees') +
      p('The site is served by Cloudflare. As with any website, the host receives the technical details of each request: ' +
        'your IP address, the address asked for, the time, and your browser&rsquo;s type. Cloudflare handles this ' +
        'under its own privacy policy, to deliver the site and keep it secure. I do not use it to identify or follow you.') +
      h('When you ask for something from another site') +
      p('Opening a level from the <strong>online archive</strong> asks archive.org for it, and opening one from ' +
        '<strong>Bonsai</strong> asks lbp.lbpbonsai.com. Your browser contacts them directly, so they see your IP address ' +
        'and which level you asked for, under their own policies. This happens only when you choose to open such a level. ' +
        'Nothing is sent to them otherwise.') +
      h('Your device&rsquo;s features') +
      p('If you use a MIDI controller, the browser asks your permission first, and what it sends is used on your device ' +
        'only. Audio is played through your browser; the site does not record anything.') +
      h('Your rights') +
      p('Because the site holds no personal data about you, there is normally nothing to access, correct or delete. ' +
        'If you are in the European Economic Area or the UK, you have rights over personal data, including access, ' +
        'correction, erasure and objection, and the right to complain to your data protection authority ' +
        '(in Italy, the Garante per la protezione dei dati personali). Write to me and I will answer.') +
      h('Children') +
      p('The site is not aimed at children and asks nobody for personal details.') +
      h('Changes') +
      p('If this ever changes, for instance if analytics were added, this page will say so before it happens. The date above says when it was last updated.'),
  },
  cookies: {
    title: 'Cookie policy',
    body:
      p('<em>Last updated 30 October 2026.</em>') +
      p('<strong>The site does not set any cookies.</strong> It has no advertising, analytics or tracking cookies, so there is ' +
        'no banner to accept or refuse.') +
      h('What it does store in your browser') +
      p('To work and to remember your layout, the site uses your browser&rsquo;s own storage. None of it is sent to a server and ' +
        'none of it identifies you:') +
      '<ul>' +
      '<li><strong>Local storage</strong>: the height of the note panel, the board zoom and whether the metronome is on.</li>' +
      '<li><strong>Cache storage</strong>: a copy of the site&rsquo;s files and of the sounds it fetched, kept by the site&rsquo;s ' +
      'service worker so the page can open without a network. It is replaced on every visit that has a connection.</li>' +
      '</ul>' +
      h('Controlling it') +
      p('You can clear all of this in your browser&rsquo;s settings (look for site data or storage). The site then starts from its ' +
        'defaults. Blocking it works too; the site still runs, but forgets your settings and cannot open offline.') +
      h('Other sites') +
      p('Levels from the online archive or Bonsai are fetched from those sites only when you ask, and they have their own ' +
        'policies. See the <a role="button" tabindex="0" data-help="privacy">privacy policy</a>.') +
      h('If this changes') +
      p('If cookies are ever added, this page will list them and ask first where the law requires it.'),
  },
};

/**
 * The wheel over an open dialog scrolls its own list or text, never the page
 * behind it. Done this way rather than by hiding the page's overflow, which
 * would drop the scrollbar, shift the page by its width and unstick the top
 * bar. For every dialog on the page, and for the ones made on demand.
 */
export function confineWheel(dialog: HTMLDialogElement): void {
  dialog.addEventListener('wheel', (event) => {
    const scroller = (event.target as Element).closest?.('.help-body, .picker-list, .picker-scroll');
    if (!(scroller instanceof HTMLElement) || scroller.scrollHeight <= scroller.clientHeight) event.preventDefault();
  }, { passive: false });
}

/**
 * Wire the dialog and every `[data-help]` button on the page, present or
 * future. Call once.
 */
export function mountHelp(): void {
  const dialog = document.getElementById('helpDialog') as HTMLDialogElement;
  const title = document.getElementById('helpTitle')!;
  const body = document.getElementById('helpBody')!;
  document.getElementById('helpClose')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  const open = (name: string | undefined) => {
    const topic = HELP[name as HelpTopic];
    if (!topic) return false;
    title.textContent = topic.title;
    body.innerHTML = topic.body;
    body.scrollTop = 0;
    dialog.showModal();
    return true;
  };
  document.addEventListener('click', (event) => {
    const button = (event.target as Element).closest?.('[data-help]');
    if (button instanceof HTMLElement) open(button.dataset.help);
  });
  // A non-button with the attribute (the version in the status bar) opens on Enter too.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const el = event.target;
    if (el instanceof HTMLElement && !(el instanceof HTMLButtonElement) && el.dataset.help) open(el.dataset.help);
  });
  for (const d of document.querySelectorAll<HTMLDialogElement>('dialog')) confineWheel(d);
}
