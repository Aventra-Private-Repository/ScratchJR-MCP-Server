import { Bridge } from '../src/bridge.js';
import { config } from '../src/config.js';
const bridge=new Bridge();
try {
  await bridge.connect(process.argv.includes('--launch'));
  console.log(JSON.stringify({config,app:await bridge.evaluate(`return {ready:typeof SJ === 'function',url:location.href,version:window.Settings.scratchJrVersion,projects:query('SELECT ID,NAME FROM PROJECTS WHERE DELETED = ?',['NO'])};`)},null,2));
} catch(error) { console.error(error.message);process.exitCode=1; }
finally {bridge.close();}
