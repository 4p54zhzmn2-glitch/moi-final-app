const handler=require('./index');
module.exports=(req,res)=>{req.query={...(req.query||{}),route:'appointments'};return handler(req,res)};
