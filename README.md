We're going to build a website to manage my home server as well as some side projects I run.

The servers will all be accessed via ssh, with the option to connect with a username and password. 


Fetch this design file, read its readme, and prepare to implement it. https://api.anthropic.com/v1/design/h/THo4RKINdxoEQ4XEcbk9LA?open_file=index.html

The first thing will be to make technical choices. I want a separate UI with an API backend. I will only be building this app with LLMs so I don't have a coding preference for either UI or API so choose the best fit particularly for backed changes to build APIs but more imrpotantly manage servers via ssh. \

A key feature of the design is streaming the SSH sessions so make sure our technology choice supports streaming, e.g. signalr is not off the table. 

I think we'll go for a file-based config for the servers and we can drop in the scripts to a particular folder. This will be nice as I can check them in to GitHub. \
\
I'm not super keen on any persistence layer other than file based, as I can port this around just by cloning the repo

Last thing, I'm a senior developer and do have an eye for detail. So even if you don't choose a language I'm familiar with, I will have opinions about folder structure. In this respect I like feature first folder structure, where folder names
match the featyre name, instea dof being grouped by what they are (e.g. no Controllers/ folder, instead it'll be ServerManager/ApiController.cs etc)

