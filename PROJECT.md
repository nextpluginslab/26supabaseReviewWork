我需要做一个系统，是 AI 自动来做 APP 的 review，就是去找真人做 review。它使用的步骤是这样子的:
1. 真人或者 agent call 那个 API，然后它自动生成一个 link，link 里写这个具体 APP review 的任务是什么东西
2. 然后可以发布这个 link
3. 发布完之后人家可以，测试者可以进到这个 link 里面完成测试，上传他测试的证据，比如说截图啊，视频啊，上传之后 AI进行审核，审核如果通过，觉得确实是合理的 review，就给他付钱。这样一个流程。
    
ICP是软件公司的需要拿到用户 feedback 的那些人，并且他们愿意付一些钱拿到 feedback。

-
我觉得需要的component
## 发布入口
入口的目的是为了给human和ai agent来提交review的task。
入口有两个
1. web UI给human
2. CLI/mcp 给ai agent

提交的任务需要下面几个选项：
1. App link：用户需要review的app/saas的link，比如google play store，ios app store，或者saas本身的链接
2. Task description：具体任务是要让真人用户review什么东西。任务的要求。
3. Price：任务的价格，可以是0
4. DDL：任务的时间，例子比如3h，3d等
5. 总budget：任务的总budget

## Task页面
当客户发布一个任务的时候，就会新建一个公开的任务页面，任务页面就是简单介绍一下任务需要做什么。然后测试者可以在任务页面里面直接提交，并且拿到付款。

## Task Submission
当这个task submit以后，我们的AI会做一次审查。如果我们的AI觉得task是可以过的（满足发布者的所有要求）话，那就告诉发布者。然后发布者确认之后就可以付钱（当然发布者也可以设置一个auto approve，不需要他确认就自动付钱了）。如果我们的AI觉得并没有满足。那就打回去让他重新提交。

## 发布者后台
发布者的后台可以看到已经提交的task，和付款情况。然后我们的AI还可以总结一下整体的一些feedback。
