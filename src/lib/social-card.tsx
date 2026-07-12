import {ImageResponse} from "next/og";

export const socialImageSize={width:1200,height:630};

export function socialCard(){
  const bars=[72,112,94,154,132,190,224];
  return new ImageResponse(<div style={{width:"100%",height:"100%",display:"flex",background:"#f8efea",color:"#3f2928",fontFamily:"Arial, sans-serif",padding:"58px 64px",position:"relative",overflow:"hidden"}}>
    <div style={{display:"flex",flexDirection:"column",width:"70%"}}>
      <div style={{display:"flex",alignItems:"center",gap:"14px",color:"#7d3034",fontSize:"25px",fontWeight:700}}><span>PERTH HOUSE DATA</span><span style={{color:"#d98782"}}>•</span><span style={{fontSize:"16px",letterSpacing:"3px"}}>OPEN SALES HISTORY</span></div>
      <div style={{display:"flex",fontFamily:"Georgia, serif",fontSize:"72px",lineHeight:1.02,letterSpacing:"-3px",color:"#7d3034",marginTop:"54px"}}>What did Perth houses<br/>really sell for?</div>
      <div style={{display:"flex",fontSize:"24px",color:"#816b68",marginTop:"28px"}}>Free, transparent and downloadable suburb analysis.</div>
      <div style={{display:"flex",gap:"12px",marginTop:"42px"}}>{["30 years","330 suburbs","281k house sales"].map(label=><div key={label} style={{display:"flex",padding:"12px 18px",border:"2px solid #e7cbc4",borderRadius:"99px",color:"#7d3034",fontSize:"18px",fontWeight:700}}>{label}</div>)}</div>
    </div>
    <div style={{display:"flex",position:"absolute",right:"58px",top:"72px",width:"260px",height:"220px",alignItems:"center",justifyContent:"center"}}>
      <div style={{display:"flex",position:"absolute",top:"12px",width:0,height:0,borderLeft:"96px solid transparent",borderRight:"96px solid transparent",borderBottom:"84px solid #b84f50"}}/>
      <div style={{display:"flex",position:"absolute",top:"93px",width:"154px",height:"112px",background:"#fffaf7",border:"8px solid #b84f50",borderTop:"0 solid transparent"}}><div style={{display:"flex",width:"42px",height:"66px",margin:"46px auto 0",background:"#f8e5e0",border:"6px solid #b84f50",borderBottom:"0 solid transparent"}}/></div>
    </div>
    <div style={{display:"flex",position:"absolute",right:"54px",bottom:"55px",height:"160px",gap:"10px",alignItems:"flex-end",padding:"0 18px 14px",borderBottom:"4px solid #e7cbc4"}}>{bars.map((height,index)=><div key={index} style={{display:"flex",width:"22px",height:`${height}px`,background:index===bars.length-1?"#b84f50":"#d98782",borderRadius:"5px 5px 0 0"}}/>)}</div>
  </div>,socialImageSize);
}
