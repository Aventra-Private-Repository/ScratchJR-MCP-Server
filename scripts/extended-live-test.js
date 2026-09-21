import assert from 'node:assert/strict';
import { ScratchJrService, withLock } from '../src/service.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.js';
const service=new ScratchJrService();
try {await withLock(async()=> {
  await service.bridge.connect();
  const resultPath=join(config.artifactDir,'live-test-result.json');
  const result=JSON.parse(await readFile(resultPath,'utf8'));
  const star=await service.addSvg({name:'MCP Star',kind:'character',width:100,height:100,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 5 L61 36 L95 36 L68 56 L78 90 L50 70 L22 90 L32 56 L5 36 L39 36 Z" fill="#ffdd33" stroke="#da8540" stroke-width="3"/></svg>'});
  const current=await service.getProject(result.projectId);
  const dog=current.data['page 1'].sprites.find(id=>current.data['page 1'][id].name==='Dog');
  const edited=await service.edit(result.projectId,current.revision,[
    {action:'add_page',page:{background:'Space.svg',texts:[{text:'You reached the stars!',x:240,y:50,size:24,color:'#ffdd33'}],characters:[{name:'Star',asset:star.md5,x:240,y:180,scale:1,scripts:[[{op:'onflag'},{op:'right',value:12},{op:'endstack'}],[{op:'onclick'},{op:'gotopage',value:1}]]}]}},
    {action:'set_scripts',pageId:'page 1',objectId:dog,scripts:[[{op:'onmessage',value:'Orange'},{op:'hop',value:2},{op:'say',value:'Click me to visit the stars!'},{op:'endstack'}],[{op:'onclick'},{op:'gotopage',value:2}]]}
  ]);
  assert.equal(edited.data.pages.length,2);
  await service.clickCharacter(dog);
  await service.bridge.waitFor(`SJ.stage.currentPage.id === 'page 2'`);
  const starShot=await service.screenshot();
  const starId=edited.data['page 2'].sprites.find(id=>edited.data['page 2'][id].name==='Star');
  await service.clickCharacter(starId);
  await service.bridge.waitFor(`SJ.stage.currentPage.id === 'page 1'`);
  await service.stop(true);await service.bridge.save();
  const finalShot=await service.screenshot();
  result.extendedPassed=true;result.customAsset=star.md5;result.starScreenshot=starShot.path;result.screenshot=finalShot.path;
  result.export=(await service.exportProject(result.projectId)).path;
  await writeFile(resultPath,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
});}finally{service.close();}
