import postgres from "postgres";

export function motherduck() {
  const token=process.env.MOTHERDUCK_TOKEN;
  if(!token) throw new Error("MOTHERDUCK_TOKEN is required");
  return postgres({
    host:process.env.MOTHERDUCK_PG_HOST||"pg.us-east-1-aws.motherduck.com",
    port:5432,
    database:"md:real_data_for_all",
    username:"postgres",
    password:token,
    ssl:"require",
    max:4,
    prepare:false,
    idle_timeout:20,
  });
}
