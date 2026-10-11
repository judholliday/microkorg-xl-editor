// Hardware the app knows in depth. Each device module says how to recognise its MIDI ports, how
// to send it a sound, and where its sounds come from (see xl/device.js for the interface). The
// sequencer, Recorder and Lab use devices only through this list.
import { device as xl } from '../xl/device.js';

export const DEVICES = [xl];

// The device on an output port (a MIDIOutput, or a port name saved in a song), or null.
export const deviceForOut = (port, name = port?.name) => DEVICES.find(d => (port ? d.isOut(port) : d.isOutName(name))) || null;
export const deviceForIn = port => DEVICES.find(d => d.isIn(port)) || null;
