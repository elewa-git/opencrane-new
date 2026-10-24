Fixed package and Git requests can prepare one private set of checked inputs. Preparation
refuses changed links and unsafe parents; cleanup removes only files it created.
Worker execution and network access remain disabled.

Failed input preparation now removes newly created directories even when opening
them fails, while leaving replacement directories alone.
