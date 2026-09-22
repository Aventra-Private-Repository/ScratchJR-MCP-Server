
const path = require('path');
const branding = require('./src/branding');

const os = require('os');
let iconFile;
let platform = os.platform();

const iconFileWindows = path.resolve(__dirname,  "src/icons/win/icon.ico");
const installerGifWindows = path.resolve(__dirname,  "src/icons/win/installerGif.gif");


const iconFileMac = path.resolve(__dirname,  "src/icons/mac/icon.icns");
if (platform === 'darwin') {
    iconFile = iconFileMac;
}
else if (platform === 'win32') {
     iconFile =   iconFileWindows;
}

module.exports = {

	make_targets: {
		win32: [
		  "squirrel"
		],
		darwin: [
		  "zip", "dmg"
		],
		linux: [
		  "deb",
		  "rpm"
		]
	},
	publishTargets: {	
      "win32": [
        "github"
      ],
      "darwin": [
        "github"
      ],
      "linux": [
        "github"
      ]
	},
	electronPackagerConfig: {
		packageManager: "npm",
		appCopyright: "Copyright (c) 2016, MIT. Modifications copyright (c) Kerneil Gocotano.",
		name: branding.productName,
		// Without this the binary would inherit the spaces and parentheses of
		// productName. Keeping it ScratchJr.exe also keeps the path the MCP
		// server probes identical to a stock install.
		executableName: branding.exeName.replace(/\.exe$/, ''),
		icon: iconFile
	},
	electronWinstallerConfig: {
		// Squirrel reads this as a NuGet package id and as the install
		// directory name, so it cannot carry the spaces in productName.
		"name": branding.installerName,
		title: branding.productName,
		description: 'ScratchJR Desktop Edition with a built-in MCP bridge',
		loadingGif: installerGifWindows,
	    iconUrl: iconFileWindows,
	    exe: branding.exeName,
	    setupIcon: iconFileWindows
	},
	electronInstallerDebian: {},
	electronInstallerRedhat: {},
	github_repository: {
		"owner": "jfo8000",
		"name": "ScratchJr-Desktop"
	},
	windowsStoreConfig: {
		"packageName": "",
		"name": branding.installerName
	}

}
  