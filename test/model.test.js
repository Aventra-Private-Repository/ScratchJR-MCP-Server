import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, compileScripts, applyEdits } from '../src/model.js';
const assets={characters:[{md5:'Dog.svg',width:296,height:213}],backgrounds:[{md5:'Park.svg',width:480,height:360}],sounds:[{md5:'pop.mp3'}]};
const spec={name:'Hello',pages:[{background:'Park.svg',characters:[{name:'Dog',asset:'Dog.svg',x:80,y:240,scripts:[[{op:'onflag'},{op:'repeat',value:2,body:[{op:'forward',value:3}]},{op:'endstack'}]]}],texts:[{text:'Hello!'}]}]};
test('compiles native ScratchJr pages, geometry, text and nested block tuples',()=> {
  const result=compileProject(spec,assets),page=result.data['page 1'];
  assert.deepEqual(result.data.pages,['page 1']);
  const dog=page[page.sprites[0]];
  assert.equal(dog.homex,80);assert.equal(dog.cx,148);
  assert.equal(dog.scripts[0][1][0],'repeat');assert.equal(dog.scripts[0][1][4][0][0],'forward');
  assert.equal(page[page.sprites[1]].str,'Hello!');assert.deepEqual(page.layers,page.sprites);
});
test('rejects unsupported assets, pages, blocks and invalid arguments before writing',()=> {
  assert.throws(()=>compileProject({...spec,pages:Array(5).fill(spec.pages[0])},assets));
  assert.throws(()=>compileProject({...spec,pages:[{characters:[{name:'x',asset:'Missing.svg'}]}]},assets),/Unknown/);
  for(const scripts of [
    [[{op:'repeat',value:2}]],[[{op:'forward',value:999}]],[[{op:'message',value:'Pink'}]],
    [[{op:'gotopage',value:4}]],[[{op:'forever'},{op:'forward'}]],[[{op:'forward'},{op:'onflag'}]],
    [[{op:'repeat',body:[{op:'onflag'}]}]],[[{op:'say',value:5}]],[[{op:'playsnd',value:'not-real.wav'}]],
  ]) assert.throws(()=>compileScripts(scripts,1));
});
test('edits preserve unrelated objects and do not mutate input',()=> {
  const initial=compileProject(spec,assets),copy=structuredClone(initial),page=initial.data['page 1'],id=page.sprites[0];
  const edited=applyEdits(initial,[{action:'set_scripts',pageId:'page 1',objectId:id,scripts:[[{op:'onclick'},{op:'hop',value:2}]]},{action:'rename',name:'New title'}],assets);
  assert.deepEqual(initial,copy);assert.equal(edited.name,'New title');
  assert.deepEqual(edited.data['page 1'][page.sprites[1]],page[page.sprites[1]]);
  assert.equal(edited.data['page 1'][id].xcoor,80);
});
test('edit validation rejects nonexistent IDs and invalid object types',()=> {
  const initial=compileProject(spec,assets);
  assert.throws(()=>applyEdits(initial,[{action:'remove_object',pageId:'page 1',objectId:'absent'}],assets),/not found/);
  const text=initial.data['page 1'].sprites[1];
  assert.throws(()=>applyEdits(initial,[{action:'set_scripts',pageId:'page 1',objectId:text,scripts:[]}],assets),/Text cannot/);
});
test('add-page and cross-page scripts work in one edit batch',()=> {
  const initial=compileProject(spec,assets),id=initial.data['page 1'].sprites[0];
  const edited=applyEdits(initial,[{action:'set_scripts',pageId:'page 1',objectId:id,scripts:[[{op:'onflag'},{op:'gotopage',value:2}]]},{action:'add_page',page:{}}],assets);
  assert.equal(edited.data.pages.length,2);
});
