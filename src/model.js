import { z } from 'zod';

export const BLOCKS = {
  onflag:{description:'Start when green flag is pressed'}, onclick:{description:'Start when character is clicked'}, ontouch:{description:'Start on character collision'},
  onmessage:{description:'Start on colored message',colors:true,default:'Orange'}, message:{description:'Send colored message',colors:true,default:'Orange'},
  forward:{description:'Move right; one step = 24 pixels',min:-20,max:20,default:1}, back:{description:'Move left',min:-20,max:20,default:1},
  up:{description:'Move up',min:-15,max:15,default:1}, down:{description:'Move down',min:-15,max:15,default:1},
  right:{description:'Turn clockwise; one unit = 30 degrees',min:-12,max:12,default:1}, left:{description:'Turn counterclockwise',min:-12,max:12,default:1},
  hop:{description:'Hop',min:-15,max:15,default:2}, home:{description:'Return to starting position'},
  say:{description:'Speech bubble',text:true,default:'Hello!'}, grow:{description:'Grow',min:-10,max:10,default:2}, shrink:{description:'Shrink',min:-10,max:10,default:2},
  same:{description:'Reset size'}, hide:{description:'Hide character'}, show:{description:'Show character'},
  playsnd:{description:'Play built-in pop sound',sound:true,default:'pop.mp3'}, playusersnd:{description:'Play numbered sound from character sounds',min:1,max:6,default:1},
  wait:{description:'Wait in tenths of a second; 10 = one second',min:0,max:50,default:10},
  setspeed:{description:'Speed: 0 slow, 1 normal, 2 fast',min:0,max:2,default:1}, stopmine:{description:'Stop other scripts for this character'},
  repeat:{description:'Repeat the blocks in body',min:0,max:24,default:4},
  endstack:{description:'End script'}, forever:{description:'Repeat entire script forever; place last'},
  gotopage:{description:'Switch to page number; place last',min:1,max:4,default:2}
};
export const colors=['Orange','Red','Yellow','Green','Blue','Purple'];
function blockSchema(depth) {
  return z.object({
    op:z.enum(Object.keys(BLOCKS)),
    value:z.union([z.string().max(500),z.number().finite()]).optional(),
    ...(depth ? {body:z.array(blockSchema(depth-1)).max(80).optional()} : {})
  }).strict();
}
export const scriptSchema=z.array(z.array(blockSchema(3)).min(1).max(80)).max(20);
const position={x:z.number().min(0).max(480).default(240),y:z.number().min(0).max(360).default(180)};
export const characterSchema=z.object({
  name:z.string().min(1).max(80),asset:z.string().min(1).max(200).describe('Exact md5 filename from scratchjr_list_assets'),
  ...position,scale:z.number().min(0.1).max(4).default(0.5),angle:z.number().min(-360).max(360).default(0),
  visible:z.boolean().default(true),flip:z.boolean().default(false),speed:z.number().int().min(0).max(2).default(1),
  sounds:z.array(z.string().max(200)).max(6).default(['pop.mp3']),scripts:scriptSchema.default([])
}).strict();
export const textSchema=z.object({text:z.string().min(1).max(1000),...position,color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#1b2a34'),size:z.union([z.literal(16),z.literal(24),z.literal(36),z.literal(48),z.literal(56),z.literal(72)]).default(36)}).strict();
export const pageSchema=z.object({background:z.string().max(200).optional(),characters:z.array(characterSchema).max(30).default([]),texts:z.array(textSchema).max(30).default([])}).strict();
export const projectSchema=z.object({name:z.string().min(1).max(120),pages:z.array(pageSchema).min(1).max(4)}).strict();

export function compileScripts(scripts,pageCount,sounds=['pop.mp3']) {
  let count=0;
  function sequence(blocks,x,y,inside=false) {
    return blocks.map((block,index)=> {
      if(++count>500) throw new Error('A character may have at most 500 blocks');
      const info=BLOCKS[block.op];
      if(!info) throw new Error(`Unknown block: ${block.op}`);
      const value=block.value ?? info.default ?? 'null';
      if(block.op.startsWith('on') && (inside || index!==0)) throw new Error('Event blocks must be first in a top-level script');
      if(['forever','endstack','gotopage'].includes(block.op) && (inside || index!==blocks.length-1)) throw new Error(`${block.op} must be last in a top-level script`);
      if(info.min!==undefined && (!Number.isInteger(value) || value<info.min || value>info.max)) throw new Error(`${block.op} needs an integer from ${info.min} to ${info.max}`);
      if(info.colors && !colors.includes(value)) throw new Error('Message color must be Orange, Red, Yellow, Green, Blue, or Purple');
      if(info.text && typeof value!=='string') throw new Error('say needs text');
      if(info.sound && value!=='pop.mp3') throw new Error('Use playsnd for pop.mp3 or playusersnd for custom sounds');
      if(block.op==='playusersnd' && Number(value)>sounds.length) throw new Error('Sound index is outside the character sounds list');
      if(block.op==='gotopage' && value>pageCount) throw new Error('gotopage refers to a missing page');
      if(block.op!=='repeat' && block.body) throw new Error('Only repeat supports body');
      if(info.default===undefined && block.value!==undefined) throw new Error(`${block.op} does not take a value`);
      const encoded=[block.op,value,x+index*72,y];
      if(block.op==='repeat') {
        if(!block.body?.length) throw new Error('repeat requires a nonempty body');
        encoded.push(sequence(block.body,x+index*72+30,y+20,true));
      }
      return encoded;
    });
  }
  return scripts.map((blocks,i)=>sequence(blocks,30,30+i*140));
}

function findAsset(assets,type,filename) {
  const asset=assets[type].find(a=>a.md5===filename);
  if(!asset) throw new Error(`Unknown ${type} asset ${filename}. Call scratchjr_list_assets.`);
  return asset;
}
export function makeCharacter(input,id,assets,pageCount) {
  const c=characterSchema.parse(input);
  const asset=findAsset(assets,'characters',c.asset);
  const w=Number(asset.width),h=Number(asset.height);
  if(!w||!h) throw new Error('Asset dimensions missing');
  for(const sound of c.sounds) if(sound!=='pop.mp3' && !assets.sounds.some(s=>s.md5===sound)) throw new Error(`Unknown sound ${sound}`);
  return {type:'sprite',id,name:c.name,md5:asset.md5,shown:c.visible,flip:c.flip,angle:c.angle,scale:c.scale,speed:c.speed,defaultScale:c.scale,
    sounds:c.sounds,xcoor:c.x,ycoor:c.y,cx:Math.floor(w/2),cy:Math.floor(h/2),w,h,
    homex:c.x,homey:c.y,homescale:c.scale,homeshown:c.visible,homeflip:c.flip,scripts:compileScripts(c.scripts,pageCount,c.sounds)};
}
export function makeText(input,id) {
  const t=textSchema.parse(input);
  return {type:'text',id,shown:true,speed:2,cx:0,cy:0,w:1,h:t.size+6,xcoor:t.x,ycoor:t.y,homex:t.x,homey:t.y,str:t.text,color:t.color,fontsize:t.size};
}
export function makePage(input,id,index,assets,pageCount) {
  const p=pageSchema.parse(input);
  const result={textstartat:36,sprites:[],num:index,layers:[]};
  if(p.background) result.md5=findAsset(assets,'backgrounds',p.background).md5;
  for(const [i,c] of p.characters.entries()) {const sid=`mcp_${id}_sprite_${i+1}`;result.sprites.push(sid);result[sid]=makeCharacter(c,sid,assets,pageCount);}
  for(const [i,t] of p.texts.entries()) {const sid=`mcp_${id}_text_${i+1}`;result.sprites.push(sid);result[sid]=makeText(t,sid);}
  result.layers=[...result.sprites];
  result.lastSprite=result.sprites.find(s=>result[s].type==='sprite') || null;
  return result;
}
export function compileProject(input,assets) {
  const spec=projectSchema.parse(input);
  const data={pages:[],currentPage:'page 1'};
  spec.pages.forEach((p,i)=>{const id=`page ${i+1}`;data.pages.push(id);data[id]=makePage(p,id,i+1,assets,spec.pages.length)});
  return {name:spec.name,data};
}

const pageId=z.string().min(1).max(100);
const objectId=z.string().min(1).max(150);
export const editSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('rename'),name:z.string().min(1).max(120)}),
  z.object({action:z.literal('add_page'),page:pageSchema}),
  z.object({action:z.literal('set_background'),pageId,asset:z.string().nullable()}),
  z.object({action:z.literal('add_character'),pageId,character:characterSchema}),
  z.object({action:z.literal('set_character'),pageId,objectId,character:characterSchema}),
  z.object({action:z.literal('set_scripts'),pageId,objectId,scripts:scriptSchema}),
  z.object({action:z.literal('add_text'),pageId,text:textSchema}),
  z.object({action:z.literal('set_text'),pageId,objectId,text:textSchema}),
  z.object({action:z.literal('remove_object'),pageId,objectId}),
]);
export function applyEdits(record,operations,assets) {
  const result=structuredClone(record),data=result.data;
  const finalPageCount=data.pages.length+operations.filter(o=>o.action==='add_page').length;
  if(finalPageCount>4) throw new Error('ScratchJr supports at most four pages');
  function unique(prefix) {let n=1;while(data.pages.some(p=>Object.hasOwn(data[p],`${prefix}${n}`))) n++;return `${prefix}${n}`;}
  for(const raw of operations) {
    const op=editSchema.parse(raw);
    if(op.action==='rename'){result.name=op.name;continue;}
    if(op.action==='add_page') {
      let n=1;while(data.pages.includes(`page ${n}`)) n++;
      const id=`page ${n}`;data.pages.push(id);data[id]=makePage(op.page,id,data.pages.length,assets,finalPageCount);continue;
    }
    if(!data.pages.includes(op.pageId)) throw new Error(`Page not found: ${op.pageId}`);
    const page=data[op.pageId];
    if(op.objectId && !page.sprites.includes(op.objectId)) throw new Error(`Object not found: ${op.objectId}`);
    switch(op.action) {
      case 'set_background': if(op.asset) page.md5=findAsset(assets,'backgrounds',op.asset).md5;else delete page.md5;break;
      case 'add_character': {const id=unique('mcp_sprite_');page[id]=makeCharacter(op.character,id,assets,finalPageCount);page.sprites.push(id);page.layers.push(id);page.lastSprite=id;break;}
      case 'set_character': if(page[op.objectId].type!=='sprite') throw new Error('Object is not a character');page[op.objectId]=makeCharacter(op.character,op.objectId,assets,finalPageCount);break;
      case 'set_scripts': if(page[op.objectId].type!=='sprite') throw new Error('Text cannot have scripts');page[op.objectId].scripts=compileScripts(op.scripts,finalPageCount,page[op.objectId].sounds);break;
      case 'add_text': {const id=unique('mcp_text_');page[id]=makeText(op.text,id);page.sprites.push(id);page.layers.push(id);break;}
      case 'set_text': if(page[op.objectId].type!=='text') throw new Error('Object is not text');page[op.objectId]=makeText(op.text,op.objectId);break;
      case 'remove_object': delete page[op.objectId];page.sprites=page.sprites.filter(x=>x!==op.objectId);page.layers=page.layers.filter(x=>x!==op.objectId);if(page.lastSprite===op.objectId) page.lastSprite=page.sprites.find(x=>page[x].type==='sprite') || null;break;
    }
    if(page.sprites.length>60) throw new Error('At most 60 objects per page');
  }
  return result;
}
