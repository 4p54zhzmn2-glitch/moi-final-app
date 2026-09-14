const handler=require('./index');
module.exports=(req,res)=>{req.query={...(req.query||{}),route:'clients'};return handler(req,res)};
