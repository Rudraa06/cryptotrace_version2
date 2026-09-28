import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { NODE_ROLES, ROLE_COLORS } from '../utils/constants.js';
import { shortenAddress } from '../utils/format.js';

export default function GraphCanvas({
  graphData,
  selectedNodeId,
  onNodeSelect,
  width,
  height,
}) {
  const fgRef = useRef(null);
  const [hoverNode, setHoverNode] = useState(null);

  const data = useMemo(() => {
    if (!graphData || !graphData.nodes) return { nodes: [], links: [] };
    
    // Create a set of valid node IDs
    const validNodeIds = new Set(graphData.nodes.map(n => n.id));
    
    // Only include links where BOTH source and target exist in the nodes array
    const validLinks = graphData.links.filter(l => {
      const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
      const targetId = typeof l.target === 'object' ? l.target.id : l.target;
      return validNodeIds.has(sourceId) && validNodeIds.has(targetId);
    });

    console.log(`GraphCanvas rendering ${graphData.nodes.length} nodes and ${validLinks.length} valid links (out of ${graphData.links.length} total)`);

    return {
      nodes: graphData.nodes.map((n) => ({ ...n })),
      links: validLinks.map((l) => ({ ...l })),
    };
  }, [graphData]);

  const paintNode = useCallback(
    (node, ctx, globalScale) => {
      try {
        const isSelected = node.id === selectedNodeId;
        const isHovered = node.id === hoverNode;
        const isExchange = node.role === NODE_ROLES.EXCHANGE;
        const isContext = node.role === NODE_ROLES.CONTEXT;

        const baseRadius = Math.sqrt(node.val ?? 4) * 2.5;
        const radius = baseRadius / Math.max(globalScale * 0.5, 0.5);

        let color = node.color ?? ROLE_COLORS[node.role] ?? '#94a3b8';

        if (node.crossCaseAlert) {
          color = '#E11D48';
        } else if (node.contractTag) {
          if (node.contractTag.type === 'dex') color = '#8B5CF6';
          else if (node.contractTag.type === 'bridge') color = '#EA580C';
          else if (node.contractTag.type === 'mixer') color = '#E11D48';
        }

        const isTraceActive = data.nodes.some(n => n.onPath);
        const isOnPath = !!node.onPath;
        const isSource = node.role === NODE_ROLES.SOURCE;
        
        let alpha = 1;
        if (isTraceActive && !isOnPath && !isSource && !node.crossCaseAlert) {
          alpha = 0.2;
        }

        if (isExchange) {
          const t = (Date.now() % 2000) / 2000;
          const pulseScale = 1 + 0.3 * Math.sin(t * Math.PI * 2);
          const pulseAlpha = (0.15 + 0.15 * Math.sin(t * Math.PI * 2)) * alpha;

          ctx.beginPath();
          ctx.arc(node.x, node.y, radius * pulseScale * 1.8, 0, 2 * Math.PI);
          ctx.fillStyle = `rgba(245, 158, 11, ${pulseAlpha})`;
          ctx.fill();
        }

        if (node.crossCaseAlert) {
          const t = (Date.now() % 1500) / 1500;
          const pulseScale = 1 + 0.35 * Math.sin(t * Math.PI * 2);
          const pulseAlpha = (0.2 + 0.2 * Math.sin(t * Math.PI * 2)) * alpha;

          ctx.beginPath();
          ctx.arc(node.x, node.y, radius * pulseScale * 2.2, 0, 2 * Math.PI);
          ctx.fillStyle = `rgba(225, 29, 72, ${pulseAlpha})`;
          ctx.fill();

          ctx.save();
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 5 / globalScale, 0, 2 * Math.PI);
          ctx.strokeStyle = '#E11D48';
          ctx.lineWidth = 2.5 / globalScale;
          ctx.setLineDash([4 / globalScale, 3 / globalScale]);
          ctx.stroke();
          ctx.restore();
        }

        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 3 / globalScale, 0, 2 * Math.PI);
          ctx.strokeStyle = isSelected ? '#F59E0B' : 'rgba(255,255,255,0.3)';
          ctx.lineWidth = 2 / globalScale;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
        
        if (isContext && !node.crossCaseAlert) {
          ctx.fillStyle = `rgba(51, 56, 69, ${alpha * 0.5})`;
        } else {
          const r = parseInt(color.slice(1, 3), 16) || 148;
          const g = parseInt(color.slice(3, 5), 16) || 163;
          const b = parseInt(color.slice(5, 7), 16) || 184;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        ctx.fill();

        if (globalScale > 0.7 && (node.label || node.crossCaseAlert)) {
          const fontSize = Math.max(10 / globalScale, 3.5);
          ctx.font = `600 ${fontSize}px var(--font-mono)`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';

          const labelText = node.crossCaseAlert 
            ? `⚠️ ${node.label ?? shortenAddress(node.addressDisplay ?? node.id)}`
            : (node.label ?? shortenAddress(node.addressDisplay ?? node.id));

          ctx.save();
          ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
          ctx.shadowBlur = 4 / globalScale;
          ctx.fillStyle = node.crossCaseAlert
            ? '#FCA5A5'
            : isContext
            ? `rgba(148, 163, 184, ${alpha * 0.75})`
            : `rgba(248, 250, 252, ${alpha * 0.9})`;

          ctx.fillText(labelText, node.x, node.y + radius + 3 / globalScale);
          ctx.restore();
        }

        if (node.contractTag?.type === 'mixer' || node.riskBreakdown?.mixer) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 2 / globalScale, 0, 2 * Math.PI);
          ctx.strokeStyle = `rgba(225, 29, 72, ${alpha})`;
          ctx.lineWidth = 1.5 / globalScale;
          ctx.stroke();
        }
      } catch (e) {
        console.error('Error in paintNode:', e);
      }
    },
    [selectedNodeId, hoverNode, data.nodes]
  );

  const paintLink = useCallback(
    (link, ctx, globalScale) => {
      try {
        const isOnPath = !!link.onPath;
        const isTraceActive = data.nodes.some(n => n.onPath);
        
        let alpha = isOnPath ? 0.8 : 0.15;
        if (isTraceActive && !isOnPath) {
          alpha = 0.05;
        }
        
        const width = isOnPath 
          ? (link.width ?? 1.5) / Math.max(globalScale * 0.7, 0.5) * 1.5
          : (link.width ?? 1) / Math.max(globalScale * 0.7, 0.5);

        const source = typeof link.source === 'object' ? link.source : data.nodes.find(n => n.id === link.source);
        const target = typeof link.target === 'object' ? link.target : data.nodes.find(n => n.id === link.target);
        if (!source?.x || !target?.x) return;

        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        
        if (link.isBridge) {
          ctx.strokeStyle = `rgba(234, 88, 12, 0.95)`;
          ctx.setLineDash([6 / globalScale, 4 / globalScale]);
          ctx.lineWidth = Math.max(2.5 / globalScale, 1.5);
        } else {
          ctx.strokeStyle = isOnPath
            ? `rgba(245, 158, 11, ${alpha})`
            : `rgba(100, 116, 139, ${alpha})`;
          ctx.setLineDash([]);
          ctx.lineWidth = width;
        }
        ctx.stroke();
        ctx.setLineDash([]);

        if (link.directed !== false) {
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len < 1) return;

          const nx = dx / len;
          const ny = dy / len;

          const targetRadius = Math.sqrt((target.val ?? 4)) * 2.5 / Math.max(globalScale * 0.5, 0.5);
          const arrowX = target.x - nx * (targetRadius + 2 / globalScale);
          const arrowY = target.y - ny * (targetRadius + 2 / globalScale);

          const arrowLen = Math.max(6 / globalScale, 2);
          const arrowWidth = Math.max(3 / globalScale, 1.5);

          ctx.beginPath();
          ctx.moveTo(arrowX, arrowY);
          ctx.lineTo(
            arrowX - nx * arrowLen + ny * arrowWidth,
            arrowY - ny * arrowLen - nx * arrowWidth
          );
          ctx.lineTo(
            arrowX - nx * arrowLen - ny * arrowWidth,
            arrowY - ny * arrowLen + nx * arrowWidth
          );
          ctx.closePath();
          ctx.fillStyle = link.isBridge
            ? `rgba(234, 88, 12, 0.95)`
            : isOnPath
            ? `rgba(245, 158, 11, ${alpha + 0.15})`
            : `rgba(100, 116, 139, ${alpha + 0.1})`;
          ctx.fill();
        }
      } catch (e) {
        console.error('Error in paintLink:', e);
      }
    },
    [data.nodes]
  );

  useEffect(() => {
    if (!fgRef.current || !data.nodes.some((n) => n.role === NODE_ROLES.EXCHANGE)) return;
    const id = setInterval(() => {
      fgRef.current?.d3ReheatSimulation?.();
    }, 50);
    const stop = setTimeout(() => clearInterval(id), 4000);
    return () => { clearInterval(id); clearTimeout(stop); };
  }, [data]);

  const handleEngineStop = useCallback(() => {
    if (fgRef.current) {
      fgRef.current.zoomToFit(400, 60);
    }
  }, []);

  if (!data.nodes.length) return null;

  return (
    <ForceGraph2D
      ref={fgRef}
      width={width}
      height={height}
      graphData={data}
      nodeCanvasObject={paintNode}
      nodePointerAreaPaint={(node, color, ctx) => {
        const r = Math.sqrt(node.val ?? 4) * 3;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      }}
      linkCanvasObject={paintLink}
      linkDirectionalParticles={(link) => (link.onPath ? 4 : 0)}
      linkDirectionalParticleWidth={(link) => (link.onPath ? 2.5 : 0)}
      linkDirectionalParticleColor={() => '#F59E0B'}
      onNodeClick={(node) => onNodeSelect(node?.id ?? null)}
      onBackgroundClick={() => onNodeSelect(null)}
      onNodeHover={(node) => {
        setHoverNode(node ? node.id : null);
        document.body.style.cursor = node ? 'pointer' : 'default';
      }}
      onEngineStop={handleEngineStop}
      backgroundColor="transparent"
      linkColor={(link) => (link.onPath ? '#F59E0B' : 'rgba(255,255,255,0.1)')}
      linkWidth={(link) => (link.onPath ? 2 : 1)}
      d3AlphaDecay={0.03}
      d3VelocityDecay={0.3}
      warmupTicks={100}
      cooldownTicks={150}
    />
  );
}
