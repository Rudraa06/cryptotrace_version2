import { findCashOutPaths } from '../src/services/trace.service.js';
import { toForceGraph } from '../src/lib/forceGraph.js';
import { enrichTraceGraph } from '../src/services/riskEngine.service.js';

async function testTrace() {
  console.log('Running mock trace for NCRP-TEST-001...');
  
  let traceResult = await findCashOutPaths('0x28C6c06298d514Db089934071355E5743bf21d60', 15);
  
  if (traceResult.found) {
    const fg = toForceGraph(traceResult);
    
    // Find the node
    const node = fg.nodes.find(n => n.id.toLowerCase() === '0x318973a740a406c3c319858d598d238a611872a1');
    console.log('NODE BEFORE ENRICHMENT:', node);
    
    const enriched = enrichTraceGraph(fg);
    const enrichedNode = enriched.nodes.find(n => n.id.toLowerCase() === '0x318973a740a406c3c319858d598d238a611872a1');
    console.log('NODE AFTER ENRICHMENT:', enrichedNode);
  } else {
    console.log('Not found');
  }
  process.exit(0);
}

testTrace().catch(console.error);
