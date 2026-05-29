pipeline {
  agent none
  parameters {
    booleanParam(name: 'BUILD_ALL', defaultValue: false, description: 'Build and deploy all services, ignoring changeset detection')
  }
  triggers {
    githubPush()
    pollSCM('H/5 * * * *')
  }
  stages {
    stage('Detect Changes') {
      agent {
        kubernetes {
          cloud 'Local k8s'
          namespace 'home-server-mgr'
          yamlFile 'deploy/pod.yaml'
          nodeSelector 'kubernetes.io/hostname=bethany'
        }
      }
      steps {
        script {
          checkout scm

          def changedFiles = []
          for (int i = 0; i < currentBuild.changeSets.size(); i++) {
              def entries = currentBuild.changeSets[i].items
              for (int j = 0; j < entries.length; j++) {
                  changedFiles.addAll(entries[j].affectedPaths)
              }
          }

          if (!changedFiles) {
              echo "No changes detected via changeSets. Falling back to git diff."
              try {
                  def prevCommit = env.GIT_PREVIOUS_SUCCESSFUL_COMMIT ?: sh(script: 'git rev-parse HEAD~1', returnStdout: true).trim()
                  def changes = sh(script: "git diff --name-only ${prevCommit}..HEAD", returnStdout: true).trim()
                  changedFiles = changes ? changes.split('\n').toList() : []
              } catch (Exception e) {
                  echo "Error during git diff fallback: ${e.message}"
              }
          }

          if (changedFiles) {
              echo "Detected changed files: ${changedFiles.unique().join(', ')}"
          } else {
              echo "No changed files detected."
          }

          // api/ image build is also needed when the shared Dockerfile or
          // deploy manifests change. config/ changes redeploy the API only
          // (to refresh the mounted ConfigMaps).
          env.API_CHANGED = (changedFiles.any { it.startsWith('api/') || it == 'deploy/Dockerfile.api' || it.startsWith('deploy/k8s/api-') }) ? 'true' : 'false'
          env.UI_CHANGED  = (changedFiles.any { it.startsWith('ui/')  || it == 'deploy/Dockerfile.ui'  || it == 'deploy/default.conf.template' || it.startsWith('deploy/k8s/ui-') }) ? 'true' : 'false'
          env.CONFIG_CHANGED = changedFiles.any { it.startsWith('config/') } ? 'true' : 'false'

          echo "API_CHANGED=${env.API_CHANGED}, UI_CHANGED=${env.UI_CHANGED}, CONFIG_CHANGED=${env.CONFIG_CHANGED}"
        }
      }
    }
    stage('Build and Deploy') {
      parallel {
        stage('API Pipeline') {
          when { anyOf { expression { env.API_CHANGED == 'true' }; expression { env.CONFIG_CHANGED == 'true' }; expression { params.BUILD_ALL } } }
          stages {
            stage('Build API Docker Image') {
              when { anyOf { expression { env.API_CHANGED == 'true' }; expression { params.BUILD_ALL } } }
              agent {
                kubernetes {
                  cloud 'Local k8s'
                  namespace 'home-server-mgr'
                  yamlFile 'deploy/pod.yaml'
                  nodeSelector 'kubernetes.io/hostname=bethany'
                }
              }
              steps {
                container('dind') {
                  withCredentials([usernamePassword(credentialsId: 'dylanmunyard-dockerhub-pat', usernameVariable: 'DOCKER_USERNAME', passwordVariable: 'DOCKER_PASSWORD')]) {
                    sh '''
                      echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin

                      docker buildx create --name multiarch-builder --driver docker-container --use || true
                      docker buildx use multiarch-builder

                      DOCKER_BUILDKIT=1 docker buildx build -f deploy/Dockerfile.api . \
                        --platform linux/amd64 \
                        --build-arg BUILDKIT_PROGRESS=plain \
                        --push \
                        -t dylanmunyard/home-server-manager:api
                    '''
                  }
                }
              }
            }
            stage('Deploy API') {
              agent {
                kubernetes {
                  cloud 'Local k8s'
                  namespace 'home-server-mgr'
                  yamlFile 'deploy/pod.yaml'
                  nodeSelector 'kubernetes.io/hostname=bethany'
                }
              }
              steps {
                container('kubectl') {
                  sh '''
                    set -euo pipefail
                    # Regenerate ConfigMaps from the checked-in config/ tree.
                    # --from-file=<dir> includes every file in the dir as a
                    # key — so adding/removing/editing files in config/ is
                    # picked up automatically without changing this script.
                    kubectl -n home-server-mgr create configmap home-server-mgr-servers \
                      --from-file=config/servers/ \
                      --dry-run=client -o yaml | kubectl apply -f -
                    kubectl -n home-server-mgr create configmap home-server-mgr-scripts \
                      --from-file=config/scripts/ \
                      --dry-run=client -o yaml | kubectl apply -f -

                    # Apply manifests (idempotent — first run creates, later runs no-op when unchanged).
                    kubectl apply -f deploy/k8s/api-deployment.yaml

                    # rollout restart guarantees pods pick up new ConfigMap
                    # content (mounted ConfigMaps refresh on the kubelet
                    # sync cycle, but a restart makes it deterministic).
                    kubectl -n home-server-mgr rollout restart deployment/home-server-mgr-api
                    kubectl -n home-server-mgr rollout status deployment/home-server-mgr-api --timeout=120s
                  '''
                }
              }
            }
          }
        }
        stage('UI Pipeline') {
          when { anyOf { expression { env.UI_CHANGED == 'true' }; expression { params.BUILD_ALL } } }
          stages {
            stage('Build UI Docker Image') {
              agent {
                kubernetes {
                  cloud 'Local k8s'
                  namespace 'home-server-mgr'
                  yamlFile 'deploy/pod.yaml'
                  nodeSelector 'kubernetes.io/hostname=bethany'
                }
              }
              steps {
                container('dind') {
                  withCredentials([usernamePassword(credentialsId: 'dylanmunyard-dockerhub-pat', usernameVariable: 'DOCKER_USERNAME', passwordVariable: 'DOCKER_PASSWORD')]) {
                    sh '''
                      echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin

                      docker buildx create --name multiarch-builder-ui --driver docker-container --use || true
                      docker buildx use multiarch-builder-ui

                      DOCKER_BUILDKIT=1 docker buildx build -f deploy/Dockerfile.ui . \
                        --platform linux/amd64 \
                        --build-arg BUILDKIT_PROGRESS=plain \
                        --push \
                        -t dylanmunyard/home-server-manager:ui
                    '''
                  }
                }
              }
            }
            stage('Deploy UI') {
              agent {
                kubernetes {
                  cloud 'Local k8s'
                  namespace 'home-server-mgr'
                  yamlFile 'deploy/pod.yaml'
                  nodeSelector 'kubernetes.io/hostname=bethany'
                }
              }
              steps {
                container('kubectl') {
                  sh '''
                    set -euo pipefail
                    kubectl apply -f deploy/k8s/ui-deployment.yaml
                    kubectl -n home-server-mgr rollout restart deployment/home-server-mgr-ui
                    kubectl -n home-server-mgr rollout status deployment/home-server-mgr-ui --timeout=120s
                  '''
                }
              }
            }
          }
        }
      }
    }
  }
}
