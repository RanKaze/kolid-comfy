

### SnapshotGaussianNode(SuperSplat模式需要安装node.js):
<img width="529" height="389" alt="image" src="https://github.com/user-attachments/assets/b00765b0-978a-41d1-98db-1da97fe10eaf" />

###### GSplat : 效果一般,从PlyPreview里扒拉来的代码.由于它的效果不是很好(好像有far clip,但是有混淆,不是很想碰,不如直接集成SuperSplat.)

###### SuperSplat : 为了效率,会保持打开一个端口为3000的服务(关闭ComfyUI也不会关闭,如果你想关,需要下个PortKiller什么的,找到3000端口关掉.但是其实不关也没什么大事).如果你的端口3000已经被其它软件占用了它将不会有效(bro我懒得改了,等有问题再说吧..)..

<img width="1858" height="1018" alt="image" src="https://github.com/user-attachments/assets/0d497ecf-3a27-4e31-a311-82fb1734f1ab" />

###### GSplat :
<img width="2460" height="1348" alt="image" src="https://github.com/user-attachments/assets/a78d43f8-0fb4-472a-87b9-d477e2e2645c" />

###### SuperSplat(魔改了一下UI界面,原版的太丑了,对我来说) :
<img width="2471" height="1351" alt="image" src="https://github.com/user-attachments/assets/dc1cc48e-731a-4e4e-b3b1-cd8c9e2e27c6" />

###### 按住Ctrl可以调整截图框,默认是节点输入的值..

### BranchNoneNode :

<img width="844" height="331" alt="image" src="https://github.com/user-attachments/assets/e22e85c3-5188-48d0-83b4-342bc2faed5d" />

###### 当check的值为None时,会调用on_none来获取值,惰性加载.

###### 如果需要的值来回在latent和image来回串,而如果不想多次encode/decode浪费性能.这个节点还不赖.

## ---------SD-PPP(需要配合我Fork的版本.小众变态需求我是真没脸PR.)------------



### SDPPPLayout, BranchToggleNode, BranchBooleanNode:

<img width="1650" height="459" alt="image" src="https://github.com/user-attachments/assets/e097b4b1-3395-4866-9211-6fac084c8a1c" />

<img width="386" height="461" alt="image" src="https://github.com/user-attachments/assets/2db51446-e86e-4ed6-9933-f91fe79fdc5e" />

###### 当你在Graph中有SDPPPLayout节点时,它会搜索同色的Branch节点,而且需要该节点名符合match_regex(正则表达式).

###### collect_BranchToggle,collect_BranchBoolean:决定了它是否收集对应的节点.

<img width="428" height="80" alt="image" src="https://github.com/user-attachments/assets/c4ef63e5-cc3b-4208-9df3-dc565b848a99" />

###### branch_mode:决定了这些Branch按照什么规则组织起来,如果选择Default就是一堆toggle,如果选了AlwaysOne(如下图)就是enum.

<img width="366" height="165" alt="image" src="https://github.com/user-attachments/assets/fa005ee8-6c87-4887-9bb5-a9021c6143a5" />

###### 来到Branch节点的属性中:

<img width="393" height="510" alt="image" src="https://github.com/user-attachments/assets/2f0f6f39-bf88-432d-8c54-12864399889c" />

###### 其中relay_expression代表它的值的表达式,如下图案例:

<img width="1798" height="594" alt="image" src="https://github.com/user-attachments/assets/03a9bfef-22d7-491d-99a1-8c546c5bb074" />

###### 其中输出图片的表达式为:输入图片||输入Latent,而输出视频的表达式为:输入图片. 支持类似 "(!节点0&&节点1)||节点3&&节点4",意味着你的节点名中不能出现"()!|&"这些字符

###### 那么当输入模式的Enum切换为输入视频时,输出视频节点的toggle就会变为true.反之为false.

###### expand_nodes决定当该节点为enable状态下,它会显示哪些节点.其格式要求为:节点名0/节点名1,必须以'/'进行分割,也意味着你的节点名不能包含'/'(active_nodes和foldout_nodes同理.)

<img width="1785" height="690" alt="image" src="https://github.com/user-attachments/assets/8c4e2a0c-fc27-48a4-a5b9-7649e446d9cc" />

###### active_nodes就是决定是否让对应节点mute,foldout_nodes是折叠(嗯.我喜欢把Preview Image和Compare Image放在一起,然后通过这个折叠完成切换,我是个怪人.).

###### 理论上来说这些节点不会产生循环依赖问题(它只沿着依赖树调用一次.但如果它真的发生了..呃可以试试把sd-ppp关掉再启动.把问题解决再加回来.)

###### hide就是hide,和海参没关系.可以让一个branch不显示在layout里,比如你想要一个branch显示expand_nodes但是又不想显示branch本身(因为它自身是通过relay_expression确定值的)

### 支持Lora Loader,TriggerWord Toggle (LoraManager):

###### 但是,它有一点BUG,你需要点一下按钮才能刷新出正确的数据.(可以点那个allow strength,因为它几乎没有安排任何功能,就当它是刷新..)

<img width="952" height="870" alt="image" src="https://github.com/user-attachments/assets/d706ce60-5d22-4c40-a5d6-006ec6a83638" />

###### 如果你不知道LoraManager,我必须猛猛安利:

<img width="2115" height="1327" alt="image" src="https://github.com/user-attachments/assets/ca24cb7f-aefc-473b-a080-6bba5d6fccac" />

###### 这样就很舒服,可以通过网页收集类似"画风笔刷"的玩意,然后在网页里切换Lora调整强度,不需要调ComfyUI里的东西.

<img width="1325" height="1076" alt="image" src="https://github.com/user-attachments/assets/86139fc3-3559-4078-9084-d56d6a76c254" />


###### 就这样吧... 这个高斯节点还挺麻烦的,顺便就全放出来了.
