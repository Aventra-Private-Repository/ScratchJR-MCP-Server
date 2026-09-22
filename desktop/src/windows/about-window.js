// About window: names, links and the licence note, all read from branding.js.

const path = require('path');
const {shell} = require('electron');
const branding = require(path.join(__dirname, '..', 'branding.js'));

document.getElementById('wordmark').textContent = branding.productName;
document.getElementById('version').textContent = 'v' + branding.version;

const list = document.getElementById('credits');
for (const credit of branding.credits) {
  const item = document.createElement('li');

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = credit.name;

  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = credit.role;

  const link = document.createElement('a');
  link.textContent = credit.url;
  link.addEventListener('click', () => shell.openExternal(credit.url));

  item.appendChild(name);
  item.appendChild(role);
  item.appendChild(link);
  list.appendChild(item);
}

document.getElementById('legal').textContent =
  'ScratchJr is a project of the Lifelong Kindergarten Group at the MIT Media Lab, ' +
  'the Developmental Technologies group at Tufts University, and the Playful Invention Company. ' +
  'This build is a modified fork of the community desktop port, distributed under the MIT licence. ' +
  'It is not produced or endorsed by MIT.';

document.getElementById('close').addEventListener('click', () => window.close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.close();
});
