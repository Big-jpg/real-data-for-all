import { describe, expect, it } from 'vitest';
import { analyse, actorInput, dateWindow, inventory, type Scope } from './apify-refresh';
const scope: Scope = {suburb:'HOCKING',postcode:'6065',state:'WA',evidence:['test']};
const record = {propertyId:'123',url:'https://www.realestate.com.au/property-house-wa-hocking-123',listingType:'sold',propertyType:'house',isSold:true,soldDate:'2026-10-01',scrapedAt:'2026-11-15T10:00:00Z',address:{full:'1 Road, Hocking, WA 6065',suburb:'Hocking',postcode:'6065',state:'WA'},soldPrice:500000};
describe('Apify refresh evidence',()=>{
 it('uses inclusive prior and current calendar months in Perth including year boundary',()=>{
  expect(dateWindow(new Date('2026-11-15T10:00:00Z'))).toEqual({from:'2026-10-01',to:'2026-11-15'});
  expect(dateWindow(new Date('2027-01-01T00:00:00Z'))).toEqual({from:'2026-12-01',to:'2027-01-01'});
 });
 it('includes archive and verified completed scopes only',()=>{
  const result=inventory({files:[{scope}]},[{name:'capture',manifest:{slices:[{...scope,status:'complete',summary:{complete:true,resolvedScopeVerified:true}},{...scope,suburb:'FAILED',status:'failed'}]}}]);
  expect(result).toEqual([{...scope,evidence:['2026-07-baseline','capture']}]);
 });
 it('sets exact sold house filters explicitly',()=>{expect(actorInput(scope,0)).toMatchObject({listingType:'sold',dateRange:'3months',includeSurrounding:false,propertyTypes:['house'],maxListings:0});});
 it('deduplicates identical rows and rejects conflicts and invalid records',()=>{
  const a=analyse([record,{...record},{...record,soldPrice:1},{...record,propertyId:'124',url:record.url.replace('123','124'),soldDate:'2026-02-30'},{...record,propertyId:'125',url:record.url.replace('123','125'),soldDate:'2026-09-30'}],scope,{from:'2026-10-01',to:'2026-11-15'});
  expect([a.inWindow,a.duplicates,a.outsideWindow,a.exceptions.length]).toEqual([1,1,1,2]);
 });
 it('rejects surrounding locality and non-house records',()=>{
  const a=analyse([{...record,address:{...record.address,suburb:'Wanneroo'}},{...record,propertyType:'unit'}],scope,{from:'2026-10-01',to:'2026-11-15'});
  expect(a.exceptions.map(x=>x.reason)).toEqual(['outside exact locality','not a confirmed sold house']);
 });
});
