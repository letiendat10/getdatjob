module.exports = {
  apps: [{
    name: "enrich-daemon",
    script: "./scripts/enrich-daemon.js",
    cwd: "/Users/dat/getdatjob",
    env: {
      NODE_PATH: "/Users/dat/getdatjob/web/node_modules"
    }
  }]
};
