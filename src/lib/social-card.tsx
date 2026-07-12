import {ImageResponse} from "next/og";

export const socialImageSize={width:1200,height:630};

export function socialCard(){
  const bars=[40,66,54,88,74,108,126];
  const facts=["30 years","330 suburbs","281k house sales"];

  return new ImageResponse(
    <div style={{width:"100%",height:"100%",display:"flex",background:"#f8efea",color:"#3f2928",fontFamily:"Arial, sans-serif",position:"relative",overflow:"hidden"}}>
      <div style={{display:"flex",position:"absolute",left:"64px",top:"54px",alignItems:"center",gap:"14px",color:"#7d3034",fontSize:"24px",fontWeight:700}}>
        <span>PERTH HOUSE DATA</span>
        <span style={{color:"#d98782"}}>•</span>
        <span style={{fontSize:"15px",letterSpacing:"3px"}}>OPEN SALES HISTORY</span>
      </div>

      <div style={{display:"flex",position:"absolute",left:"64px",top:"146px",width:"780px",flexDirection:"column"}}>
        <div style={{display:"flex",fontFamily:"Georgia, serif",fontSize:"65px",lineHeight:1,letterSpacing:"-2px",color:"#7d3034"}}>What did Perth houses</div>
        <div style={{display:"flex",fontFamily:"Georgia, serif",fontSize:"65px",lineHeight:1,letterSpacing:"-2px",color:"#7d3034",marginTop:"8px"}}>really sell for?</div>
        <div style={{display:"flex",fontSize:"23px",color:"#816b68",marginTop:"28px"}}>Free, transparent and downloadable suburb analysis.</div>
      </div>

      <div style={{display:"flex",position:"absolute",left:"64px",bottom:"62px",gap:"12px"}}>
        {facts.map(label=><div key={label} style={{display:"flex",padding:"11px 17px",border:"2px solid #e7cbc4",borderRadius:"99px",color:"#7d3034",fontSize:"17px",fontWeight:700}}>{label}</div>)}
      </div>

      <div style={{display:"flex",position:"absolute",right:"55px",top:"78px",width:"250px",height:"474px",borderLeft:"2px solid #e7cbc4",flexDirection:"column",alignItems:"center",justifyContent:"space-between",paddingLeft:"36px"}}>
        <div style={{display:"flex",width:"164px",height:"164px",border:"5px solid #b84f50",borderRadius:"999px",alignItems:"center",justifyContent:"center",color:"#b84f50",fontFamily:"Georgia, serif",fontSize:"116px",lineHeight:1,paddingBottom:"12px"}}>⌂</div>
        <div style={{display:"flex",height:"166px",gap:"9px",alignItems:"flex-end",padding:"0 12px 13px",borderBottom:"4px solid #e7cbc4"}}>
          {bars.map((height,index)=><div key={index} style={{display:"flex",width:"20px",height:`${height}px`,background:index===bars.length-1?"#b84f50":"#d98782",borderRadius:"5px 5px 0 0"}}/>)}
        </div>
      </div>
    </div>,
    socialImageSize,
  );
}
