// Test double for supervised programs. Usage: node fake-app.mjs <mode> [ms]
//   crash <ms>   exit with code 3 after <ms>
//   run          run until stopped; exits 0 on the IPC message {type:'shutdown'}
//   stubborn     run and ignore the IPC shutdown request
const [mode = 'run', ms = '200'] = process.argv.slice(2);
console.log(`fake-app ${mode} pid=${process.pid}`);
const keepAlive = setInterval(() => undefined, 1000);
if (mode === 'crash') {
  setTimeout(() => process.exit(3), Number(ms));
}
process.on('message', (message) => {
  if (message?.type === 'shutdown' && mode !== 'stubborn') {
    clearInterval(keepAlive);
    console.log('fake-app: clean shutdown');
    process.exit(0);
  }
});
