const ts = () => new Date().toISOString();

function fmt(args) {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

module.exports = {
  info: (...a) => console.log(`[${ts()}] [info] ${fmt(a)}`),
  warn: (...a) => console.warn(`[${ts()}] [warn] ${fmt(a)}`),
  error: (...a) => console.error(`[${ts()}] [error] ${fmt(a)}`),
  debug: (...a) => {
    if (process.env.DEBUG) console.log(`[${ts()}] [debug] ${fmt(a)}`);
  },
};