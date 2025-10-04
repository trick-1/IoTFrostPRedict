This is the github repository of an IoT Frost Prediction application written as a series of microservices.

To use this code clone the repository to your local machine and install docker.io

for each microservice 
sudo docker build -t <microservicename> .

At which point you can use docker compose to run the image 

if you wish to save the docker images then use
sudo docker save -o <microservicename>.tar <microservicename>

The code can run all on localhost or distributed across a number of machines. Please make sure you check the various environment variables and update to suite your environment.

There are features for SSL support and helper scripts to generate non-public certificates. This is turned off by default.

The following ports are exposed and used by other microservices or end users.
Microservice	Exposed	Used by
APISec	3000	Inference, STA, WebSec
WebSec	8080	End users
Inference	8060	WebSec, STA
STA	3010	WebSec
