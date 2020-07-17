// show the installed versions of packages
//
// --parseable creates output like this:
// <fullpath>:<name@ver>:<realpath>:<flags>
// Flags are a :-separated list of zero or more indicators

var usage = require('./utils/usage')
module.exports = Object.assign((args, cb) => cb(), {
  usage: usage('ls', 'npm ls [[<@scope>/]<pkg> ...]')
})
