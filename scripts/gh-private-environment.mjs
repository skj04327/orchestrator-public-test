// Trusted gh child environment only. Never hand it to a game process.
export function ghPrivateEnvironment(){
  const env={GH_NO_UPDATE_NOTIFIER:'1',GH_PROMPT_DISABLED:'1'};
    for(const key of ['PATH','HOME','XDG_CONFIG_HOME','GH_CONFIG_DIR','GH_TOKEN','GITHUB_TOKEN',
      'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR'])
      if(process.env[key]!==undefined)env[key]=process.env[key];
  return env;
}
