//
//  branding.js - identity of this modified build.
//
//  Everything user-visible about the fork's name lives here so a rename is a
//  one-file change. Upstream ScratchJr Desktop has no equivalent file.
//
//  Note: productName may contain spaces and punctuation, installerName may not.
//  Squirrel treats installerName as a NuGet package id, so it is restricted to
//  letters, digits, dot, dash and underscore, and it also decides the install
//  directory: %LOCALAPPDATA%\<installerName>\app-<version>\<exeName>

const productName = 'ScratchJR (Modified by Kerneil Gocotano)';

module.exports = {
  productName: productName,
  version: '1.0.1',
  installerName: 'ScratchJR-Modified-KerneilGocotano',
  exeName: 'ScratchJr.exe',
  windowTitle: productName + ' v1.0.1',

  // Chrome DevTools Protocol port the bundled MCP server attaches to.
  // Set SCRATCHJR_DEBUG_PORT=0 to start without the MCP listener.
  mcpDebugPort: Number(process.env.SCRATCHJR_DEBUG_PORT === undefined ? 9223 : process.env.SCRATCHJR_DEBUG_PORT),
};
